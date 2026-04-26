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

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_SRC = join(__dirname, "nowplaying_helper.swift");
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
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

wss.on("listening", () => {
  log(`ws listening on ws://${WS_HOST}:${WS_PORT}`);
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
  } catch { /* ignore */ }
  sock.on("error", () => { /* ignore */ });
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
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down…`);
  if (pollTimer) clearInterval(pollTimer);
  if (helper && !helper.killed) {
    try { helper.stdin.write("q\n"); } catch { /* ignore */ }
    setTimeout(() => {
      if (helper && !helper.killed) {
        try { helper.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }, 250);
  }
  try {
    wss.close(() => process.exit(0));
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
