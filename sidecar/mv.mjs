// sidecar/mv.mjs
//
// Music video acquisition + serving for the `mv` vibe.
//
// - search_and_fetch(track) -> ensures a local MP4 exists for {title, artist}.
//   Uses yt-dlp under the hood. Cached by youtube id; concurrent requests for
//   the same track coalesce.
// - HTTP routes:
//     GET /mv?title=X&artist=Y     -> { state, videoId?, url?, error? }
//     GET /mv-file/<id>.mp4        -> serves the cached file (Range supported)
//
// Failure modes surface as { state: "error", error: "..." } so the renderer
// can show actionable guidance (e.g. "install yt-dlp").

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "mv-cache");
const META_DIR = join(CACHE_DIR, "meta");

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
if (!existsSync(META_DIR)) mkdirSync(META_DIR, { recursive: true });

const log = (...a) => process.stderr.write("[mv] " + a.join(" ") + "\n");

// ---------------------------------------------------------------------------
// State machine: per-trackKey { state, videoId?, file?, error?, promise? }
// ---------------------------------------------------------------------------

const tracks = new Map(); // trackKey -> entry

function trackKey(title, artist) {
  return createHash("sha1")
    .update(`${(title ?? "").toLowerCase().trim()}|${(artist ?? "").toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 16);
}

function findCachedFile(videoId) {
  // Look for "<videoId>.<ext>" in CACHE_DIR.
  if (!videoId) return null;
  for (const name of readdirSync(CACHE_DIR)) {
    if (name.startsWith(videoId + ".")) {
      const full = join(CACHE_DIR, name);
      if (statSync(full).isFile()) return name;
    }
  }
  return null;
}

function metaPath(key) { return join(META_DIR, key + ".json"); }

async function readMeta(key) {
  try {
    const { readFile } = await import("node:fs/promises");
    const txt = await readFile(metaPath(key), "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

async function writeMeta(key, obj) {
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(metaPath(key), JSON.stringify(obj));
  } catch (e) { log("meta write failed", e.message); }
}

// ---------------------------------------------------------------------------
// yt-dlp invocation
// ---------------------------------------------------------------------------

// Re-check yt-dlp on each request rather than caching at startup — the user
// might install it after the sidecar is already running. Cost: ~25ms.
// We only log the "missing" warning once per session to avoid spam.
let ytdlpMissingLogged = false;
function ensureYtdlp() {
  const r = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok && !ytdlpMissingLogged) {
    log("yt-dlp not found on PATH. Install with: brew install yt-dlp");
    ytdlpMissingLogged = true;
  } else if (ok && ytdlpMissingLogged) {
    log("yt-dlp now available (" + r.stdout.trim() + ")");
    ytdlpMissingLogged = false;
  }
  return ok;
}

function ytdlp(args, onStderr) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    if (onStderr) child.stderr.on("data", (b) => onStderr(b.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout }));
    child.on("error", (err) => resolve({ code: -1, stdout: "", error: err.message }));
  });
}

async function searchAndDownload(title, artist) {
  if (!ensureYtdlp()) {
    return { error: "yt-dlp not installed. Run: brew install yt-dlp" };
  }

  const query = `ytsearch1:${title} ${artist} official music video`.trim();
  const outTemplate = join(CACHE_DIR, "%(id)s.%(ext)s");
  // Cap at 720p, prefer mp4 for HTML video compatibility. Falls back to best
  // 720p or under if mp4 isn't available.
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--no-progress",
    "-f", "best[height<=720][ext=mp4]/best[height<=720]/best",
    "--print", "id",
    "--print", "after_move:filepath",
    "-o", outTemplate,
    query,
  ];
  log("yt-dlp", args.slice(-2).join(" "));
  const { code, stdout, error } = await ytdlp(args, (s) => {
    const trimmed = s.trim();
    if (trimmed) log("yt-dlp:", trimmed);
  });
  if (code !== 0) {
    return { error: error ?? `yt-dlp exited ${code}` };
  }
  const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const videoId = lines[0];
  let file = lines[1] ?? null;
  if (!videoId) return { error: "yt-dlp returned no video id" };
  if (!file) {
    // Older yt-dlp versions don't honor `after_move:filepath`. Reconstruct
    // by scanning the cache dir for a file starting with the video id.
    const name = findCachedFile(videoId);
    if (name) file = join(CACHE_DIR, name);
  }
  if (!file || !existsSync(file)) {
    return { error: `download finished but file not found for ${videoId}` };
  }
  return { videoId, file };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function ensureMv(title, artist) {
  const key = trackKey(title, artist);
  const existing = tracks.get(key);
  if (existing && existing.state !== "error") return existing;

  // Check on-disk cache first (survives sidecar restart).
  const meta = await readMeta(key);
  if (meta?.videoId) {
    const cached = findCachedFile(meta.videoId);
    if (cached) {
      const entry = {
        state: "ready",
        videoId: meta.videoId,
        file: cached,
        title, artist,
      };
      tracks.set(key, entry);
      return entry;
    }
  }

  // Mark in-flight; coalesce concurrent callers via the same promise.
  const entry = { state: "downloading", title, artist };
  entry.promise = (async () => {
    const result = await searchAndDownload(title, artist);
    if (result.error) {
      const errEntry = { state: "error", error: result.error, title, artist };
      tracks.set(key, errEntry);
      return errEntry;
    }
    const fileName = result.file.split("/").pop();
    const ready = {
      state: "ready",
      videoId: result.videoId,
      file: fileName,
      title, artist,
    };
    tracks.set(key, ready);
    await writeMeta(key, { videoId: result.videoId, file: fileName, title, artist, fetchedAt: Date.now() });
    return ready;
  })();
  tracks.set(key, entry);
  return entry.promise;
}

function publicEntry(entry) {
  if (!entry) return { state: "missing" };
  if (entry.state === "ready") {
    return { state: "ready", videoId: entry.videoId, url: `/mv-file/${entry.file}` };
  }
  if (entry.state === "downloading") return { state: "downloading" };
  if (entry.state === "error") return { state: "error", error: entry.error };
  return { state: entry.state };
}

// ---------------------------------------------------------------------------
// HTTP request handler — wire from the host http server.
// ---------------------------------------------------------------------------

export async function handleHttp(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/mv") {
    const title = url.searchParams.get("title") ?? "";
    const artist = url.searchParams.get("artist") ?? "";
    if (!title) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "error", error: "missing title" }));
      return true;
    }
    if (!ensureYtdlp()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "error", error: "yt-dlp not installed. Run: brew install yt-dlp" }));
      return true;
    }
    // Kick off (or resume) the fetch but don't await — return current state
    // so the renderer can poll. If already ready, await briefly to send url.
    const key = trackKey(title, artist);
    let entry = tracks.get(key);
    if (!entry) {
      // First touch: start in background.
      void ensureMv(title, artist);
      entry = tracks.get(key);
    }
    // If we have a "downloading" entry mid-flight and the response is fast,
    // give it a brief head start to convert to "ready" without polling.
    if (entry?.state === "downloading" && entry.promise) {
      const raced = await Promise.race([
        entry.promise,
        new Promise((r) => setTimeout(() => r(null), 50)),
      ]);
      if (raced) entry = raced;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(publicEntry(entry)));
    return true;
  }

  if (url.pathname.startsWith("/mv-file/")) {
    const fileName = url.pathname.slice("/mv-file/".length);
    if (fileName.includes("/") || fileName.includes("..")) {
      res.writeHead(400); res.end(); return true;
    }
    const full = join(CACHE_DIR, fileName);
    if (!existsSync(full)) { res.writeHead(404); res.end(); return true; }
    serveFile(req, res, full);
    return true;
  }

  return false;
}

function serveFile(req, res, path) {
  const stat = statSync(path);
  const total = stat.size;
  const range = req.headers["range"];
  const ext = path.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "webm" ? "video/webm" :
    ext === "mkv" ? "video/x-matroska" :
    "application/octet-stream";

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Length": total,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  createReadStream(path).pipe(res);
}
