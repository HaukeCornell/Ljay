// sidecar/index.mjs
//
// Ljay Now Playing sidecar.
//
// 1. Spawns the Swift helper (sidecar/nowplaying_helper), JIT-compiling it
//    on first run via `swiftc -O`.
// 2. Drives 30 Hz polling by writing "p\n" to the helper's stdin.
// 3. Parses each helper JSON line, derives a Playhead with extrapolation,
//    and emits TrackSourceEvent objects over a local WebSocket
//    (ws://127.0.0.1:7777).
// 4. New WS clients receive a fresh full-state burst on connect.
//
// Logs go to stderr only (stdout is reserved in case anyone pipes us).

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { handleHttp as handleMv } from "./mv.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const HELPER_SRC = join(__dirname, "nowplaying_helper.swift");
const LINK_HELPER_SRC = join(__dirname, "link_helper.cpp");
const LINK_HELPER_BIN = join(__dirname, "link_helper");
// We run the helper through `/usr/bin/swift` rather than compiling it.
// Apple's MediaRemote framework returns empty data to unsigned/ad-hoc
// binaries on macOS Sequoia+ but works fine when invoked through the
// signed swift interpreter.
const WS_HOST = "127.0.0.1";
const WS_PORT = 7777;
const POLL_HZ = 30;
const POLL_INTERVAL_MS = 1000 / POLL_HZ;
const HELPER_RESPAWN_BACKOFF_MS = 500;
const HELPER_RESPAWN_MAX = 10;

const log = (...a) => process.stderr.write("[sidecar] " + a.join(" ") + "\n");

// ---------------------------------------------------------------------------
// Event/state machinery
// ---------------------------------------------------------------------------

let seq = 0;
const nextSeq = () => ++seq;

/** Last "now-playing" event we sent (for new-client burst & dedup). */
let lastNowPlayingEvent = null;
/** Last "playhead" event we sent (for new-client burst). */
let lastPlayheadEvent = null;
/** Last "link" event we sent (for new-client burst). */
let lastLinkEvent = null;

// ---------------------------------------------------------------------------
// Control state — shared "remote-control" plane between the renderer and any
// number of control panels. Last-write-wins. Path-keyed (e.g.,
// "currentVibe", "lyricAnimation", "video.mode", "effectParams.halftone.color").
// Persists to disk so panels rejoin a session intact.
// ---------------------------------------------------------------------------

const CONTROL_STATE_PATH = join(__dirname, "control-state.json");
let controlState = {};
try {
  if (existsSync(CONTROL_STATE_PATH)) {
    const txt = readFileSync(CONTROL_STATE_PATH, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") controlState = parsed;
  }
} catch (e) { log("control-state load failed:", e.message); }

let controlSaveTimer = null;
function persistControlState() {
  if (controlSaveTimer) clearTimeout(controlSaveTimer);
  controlSaveTimer = setTimeout(() => {
    try { writeFileSync(CONTROL_STATE_PATH, JSON.stringify(controlState, null, 2)); }
    catch (e) { log("control-state save failed:", e.message); }
  }, 350);
}

/** Set a path-keyed value into controlState. Does not broadcast — caller does. */
function setControlPath(path, value) {
  if (!path || typeof path !== "string") return;
  // Path can be "a.b.c" — split and walk/create.
  const parts = path.split(".");
  let cur = controlState;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}
/** True if our most recent terminal state was "stopped"; suppresses repeats. */
let stoppedLatched = false;
/** Last contentItemId we sent artwork for; only re-send artwork on change. */
let lastContentItemId = null;
/** Identity tuple for now-playing dedup. */
let lastIdentityKey = null;

/** Broadcast a TrackSourceEvent to all clients & remember last-of-kind. */
function emit(event) {
  if (event.kind === "now-playing") {
    lastNowPlayingEvent = event;
    stoppedLatched = false;
  } else if (event.kind === "playhead") {
    lastPlayheadEvent = event;
    stoppedLatched = false;
  } else if (event.kind === "link") {
    lastLinkEvent = event;
  } else if (event.kind === "stopped") {
    // Keep lastNowPlaying/lastPlayhead so reconnecting clients still see the
    // last-known track context, but mark stopped so we won't re-emit.
    stoppedLatched = true;
  }
  const json = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(json); } catch { /* ignore */ }
    }
  }
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server (one port, two protocols)
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  // Off-load /mv* to the music-video module.
  if (req.url && (req.url.startsWith("/mv?") || req.url === "/mv" || req.url.startsWith("/mv-file/"))) {
    try {
      const handled = await handleMv(req, res);
      if (handled) return;
    } catch (e) {
      log("mv handler threw:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: "error", error: e.message }));
      }
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

httpServer.listen(WS_PORT, WS_HOST, () => {
  log(`http+ws listening on http://${WS_HOST}:${WS_PORT} (ws://${WS_HOST}:${WS_PORT})`);
});

httpServer.on("error", (err) => {
  log("http server error:", err.message);
});

wss.on("error", (err) => {
  log("ws server error:", err.message);
});

wss.on("connection", (sock, req) => {
  log(`client connected (${req.socket.remoteAddress})`);
  // Burst: replay last known state so a renderer reload re-syncs.
  try {
    if (lastNowPlayingEvent) sock.send(JSON.stringify(lastNowPlayingEvent));
    if (lastPlayheadEvent)   sock.send(JSON.stringify(lastPlayheadEvent));
    if (lastLinkEvent)       sock.send(JSON.stringify(lastLinkEvent));
    // Replay the entire control state as a single snapshot so a panel
    // joining mid-session sees what's already configured.
    sock.send(JSON.stringify({ kind: "control-snapshot", state: controlState, seq: nextSeq() }));
  } catch { /* ignore */ }
  sock.on("error", () => { /* ignore */ });
  sock.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "control-set" && typeof msg.path === "string") {
      setControlPath(msg.path, msg.value);
      persistControlState();
      const out = JSON.stringify({ kind: "control-update", path: msg.path, value: msg.value, seq: nextSeq() });
      for (const client of wss.clients) {
        if (client.readyState === 1 && client !== sock) {
          try { client.send(out); } catch { /* ignore */ }
        }
      }
      // Echo back to sender so they can confirm the round-trip if they want.
      try { sock.send(out); } catch { /* ignore */ }
    } else if (msg.kind === "control-reset") {
      controlState = {};
      persistControlState();
      const out = JSON.stringify({ kind: "control-snapshot", state: controlState, seq: nextSeq() });
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          try { client.send(out); } catch { /* ignore */ }
        }
      }
    } else if (msg.kind === "control-batch" && Array.isArray(msg.entries)) {
      for (const e of msg.entries) {
        if (e && typeof e.path === "string") setControlPath(e.path, e.value);
      }
      persistControlState();
      const out = JSON.stringify({ kind: "control-snapshot", state: controlState, seq: nextSeq() });
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          try { client.send(out); } catch { /* ignore */ }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helper process management
// ---------------------------------------------------------------------------

let helper = null;
let helperStdoutBuf = "";
let helperRespawns = 0;
let pollTimer = null;
let shuttingDown = false;

function startHelper() {
  log("spawning helper via swift:", HELPER_SRC);
  helper = spawn("/usr/bin/swift", [HELPER_SRC], { stdio: ["pipe", "pipe", "pipe"] });
  helperStdoutBuf = "";

  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", onHelperStdout);
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (s) => {
    // Filter out swift's verbose warning blocks. Real errors still come through.
    const trimmed = s.trim();
    if (!trimmed) return;
    if (
      trimmed.includes("warning:") ||
      trimmed.includes("note:") ||
      /^\s*\d+\s*\|/.test(trimmed) ||
      /^\s*[\^|`]/.test(trimmed)
    ) return;
    process.stderr.write("[helper] " + s);
  });

  helper.on("exit", (code, signal) => {
    log(`helper exited code=${code} signal=${signal}`);
    if (shuttingDown) return;
    if (helperRespawns >= HELPER_RESPAWN_MAX) {
      log(`helper respawn cap (${HELPER_RESPAWN_MAX}) reached — giving up.`);
      process.exit(1);
    }
    helperRespawns++;
    log(`respawning helper in ${HELPER_RESPAWN_BACKOFF_MS}ms ` +
        `(attempt ${helperRespawns}/${HELPER_RESPAWN_MAX})`);
    setTimeout(startHelper, HELPER_RESPAWN_BACKOFF_MS);
  });

  helper.on("error", (err) => {
    log("helper spawn error:", err.message);
  });

  // Reset poll cadence — restart the timer so a stale tick doesn't pile up.
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

function pollTick() {
  if (!helper || helper.killed || !helper.stdin.writable) return;
  try {
    helper.stdin.write("p\n");
  } catch (e) {
    log("failed to write poll command:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Helper output parsing
// ---------------------------------------------------------------------------

function onHelperStdout(chunk) {
  helperStdoutBuf += chunk;
  let nl;
  while ((nl = helperStdoutBuf.indexOf("\n")) !== -1) {
    const line = helperStdoutBuf.slice(0, nl).trim();
    helperStdoutBuf = helperStdoutBuf.slice(nl + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) {
      log("bad JSON from helper:", line.slice(0, 120));
      continue;
    }
    handleHelperFrame(obj);
  }
}

function handleHelperFrame(f) {
  // Successful poll always resets respawn backoff so transient crashes don't
  // accumulate forever.
  helperRespawns = 0;

  if (f && f.empty === true) {
    if (!stoppedLatched) {
      emit({ kind: "stopped", seq: nextSeq() });
    }
    return;
  }

  const title = f.title ?? "";
  const artist = f.artist ?? "";
  const album = f.album ?? undefined;
  const durationSec = typeof f.durationSec === "number" ? f.durationSec : 0;
  const elapsedSec = typeof f.elapsedSec === "number" ? f.elapsedSec : 0;
  const timestamp = typeof f.timestamp === "number"
    ? f.timestamp : (Date.now() / 1000);
  const rate = typeof f.playbackRate === "number" ? f.playbackRate : 1.0;
  const contentItemId = typeof f.contentItemId === "string"
    ? f.contentItemId : undefined;

  const durationMs = Math.max(0, Math.round(durationSec * 1000));

  // ----- now-playing dedup -----
  // Identity per spec: title+artist+sourceId, or title+artist+duration.
  const identityKey = contentItemId
    ? `${title}|${artist}|id:${contentItemId}`
    : `${title}|${artist}|d:${durationMs}`;

  if (identityKey !== lastIdentityKey) {
    lastIdentityKey = identityKey;

    // Artwork: only forward when contentItemId changed (or first time we've
    // seen any track). Even then only if helper provided it.
    let artworkDataUrl = undefined;
    const newContentId = contentItemId ?? null;
    if (newContentId !== lastContentItemId
        && typeof f.artworkB64 === "string" && f.artworkB64.length > 0) {
      const mime = typeof f.artworkMime === "string" && f.artworkMime
        ? f.artworkMime : "image/jpeg";
      artworkDataUrl = `data:${mime};base64,${f.artworkB64}`;
    }
    lastContentItemId = newContentId;

    const track = {
      title,
      artist,
      durationMs,
    };
    if (album)          track.album = album;
    if (contentItemId)  track.sourceId = contentItemId;
    if (artworkDataUrl) track.artworkDataUrl = artworkDataUrl;

    emit({ kind: "now-playing", track, seq: nextSeq() });
  }

  // ----- playhead (every poll) -----
  // positionMs = (elapsed + (now - timestamp) * rate) * 1000, clamped.
  const nowSec = Date.now() / 1000;
  const extrapolatedSec = elapsedSec + (nowSec - timestamp) * rate;
  let positionMs = extrapolatedSec * 1000;
  positionMs = clamp(positionMs, 0, durationMs > 0 ? durationMs : positionMs);

  const playhead = {
    positionMs,
    rate,
    anchorMs: performance.now(),
  };
  emit({ kind: "playhead", playhead, seq: nextSeq() });
}

// ---------------------------------------------------------------------------
// Ableton Link helper — parallel C++ subprocess that joins the local Link
// session and reports BPM + beat phase + peer count. JIT-built with clang++
// on first run if the binary doesn't exist yet.
// ---------------------------------------------------------------------------

let linkHelper = null;
let linkStdoutBuf = "";
let linkPollTimer = null;
let linkRespawns = 0;
const LINK_HELPER_RESPAWN_MAX = 5;

function ensureLinkHelperBuilt() {
  if (existsSync(LINK_HELPER_BIN)) return true;
  if (!existsSync(LINK_HELPER_SRC)) {
    log("link helper source missing — skipping Link integration");
    return false;
  }
  const linkRoot = join(PROJECT_ROOT, "vendor", "link");
  if (!existsSync(linkRoot)) {
    log("vendor/link missing — skipping Link integration. To enable: git clone https://github.com/Ableton/link.git vendor/link --recurse-submodules");
    return false;
  }
  log("link helper missing, building with clang++…");
  const r = spawnSync("clang++", [
    "-std=c++17", "-O2",
    "-I", join(linkRoot, "include"),
    "-I", join(linkRoot, "extensions", "abl_link", "include"),
    "-I", join(linkRoot, "modules", "asio-standalone", "asio", "include"),
    "-DLINK_PLATFORM_MACOSX=1",
    join(linkRoot, "extensions", "abl_link", "src", "abl_link.cpp"),
    LINK_HELPER_SRC,
    "-o", LINK_HELPER_BIN,
    "-framework", "CoreFoundation",
  ], { cwd: PROJECT_ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    log(`link helper build failed (status=${r.status}); continuing without Link`);
    return false;
  }
  log("link helper built ok.");
  return true;
}

function startLinkHelper() {
  if (!ensureLinkHelperBuilt()) return;
  log("spawning link helper:", LINK_HELPER_BIN);
  linkHelper = spawn(LINK_HELPER_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  linkStdoutBuf = "";

  linkHelper.stdout.setEncoding("utf8");
  linkHelper.stdout.on("data", onLinkStdout);
  linkHelper.stderr.setEncoding("utf8");
  linkHelper.stderr.on("data", (s) => {
    const trimmed = s.trim();
    if (trimmed) process.stderr.write("[link] " + s);
  });

  linkHelper.on("exit", (code, signal) => {
    log(`link helper exited code=${code} signal=${signal}`);
    if (shuttingDown) return;
    if (linkRespawns >= LINK_HELPER_RESPAWN_MAX) {
      log(`link helper respawn cap reached — giving up.`);
      return;
    }
    linkRespawns++;
    setTimeout(startLinkHelper, HELPER_RESPAWN_BACKOFF_MS);
  });

  linkHelper.on("error", (err) => {
    log("link helper spawn error:", err.message);
  });

  if (linkPollTimer) clearInterval(linkPollTimer);
  linkPollTimer = setInterval(linkPollTick, POLL_INTERVAL_MS);
}

function linkPollTick() {
  if (!linkHelper || linkHelper.killed || !linkHelper.stdin.writable) return;
  try { linkHelper.stdin.write("p\n"); }
  catch (e) { log("failed to write link poll:", e.message); }
}

function onLinkStdout(chunk) {
  linkStdoutBuf += chunk;
  let nl;
  while ((nl = linkStdoutBuf.indexOf("\n")) !== -1) {
    const line = linkStdoutBuf.slice(0, nl).trim();
    linkStdoutBuf = linkStdoutBuf.slice(nl + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { log("bad JSON from link helper:", line.slice(0, 120)); continue; }
    handleLinkFrame(obj);
  }
}

/** A "link" event carries the renderer-side anchor: BPM + the beat phase
 *  at the moment of capture, alongside an `anchorMs` (perf clock) so the
 *  renderer can extrapolate phase locally between updates. */
function handleLinkFrame(f) {
  if (typeof f.bpm !== "number") return; // {ready:true} or malformed
  linkRespawns = 0;
  const link = {
    bpm: f.bpm,
    phase: typeof f.phase === "number" ? f.phase : 0,
    beat: typeof f.beat === "number" ? f.beat : 0,
    quantum: typeof f.quantum === "number" ? f.quantum : 4,
    peers: typeof f.peers === "number" ? f.peers : 0,
    playing: !!f.playing,
    anchorMs: performance.now(),
  };
  emit({ kind: "link", link, seq: nextSeq() });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down…`);
  if (pollTimer) clearInterval(pollTimer);
  if (linkPollTimer) clearInterval(linkPollTimer);
  for (const child of [helper, linkHelper]) {
    if (child && !child.killed) {
      try { child.stdin.write("q\n"); } catch { /* ignore */ }
      setTimeout(() => {
        if (child && !child.killed) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 250);
    }
  }
  try {
    wss.close();
    httpServer.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  // Hard fallback in case ws.close hangs.
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

startHelper();
startLinkHelper();
