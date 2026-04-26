import type { AudioFrame, LyricStyle, NowPlaying, Vibe, VibeHost } from "../types.ts";
import { subscribe } from "../state/store";

// "Music Video" vibe.
// - Subscribes to the global app state so it always knows what's playing.
// - When `nowPlaying` changes, asks the sidecar to fetch+cache the official
//   music video (yt-dlp under the hood) and points the <video> at it.
// - Drives `video.currentTime` from the DJ playhead and `video.playbackRate`
//   from playhead.rate. Manual offset (per-track, ms) nudges with [ / ].
//
// Audio: ALWAYS muted. The DJ's audio is the only audio.

const SYNC_DRIFT_MS = 220; // hard-seek when video drifts beyond this
const POLL_DOWNLOAD_MS = 1500;

type MvState =
  | { state: "idle" }
  | { state: "missing" }
  | { state: "downloading" }
  | { state: "ready"; videoId: string; url: string }
  | { state: "error"; error: string };

interface OffsetCache {
  [trackKey: string]: number;
}

function offsetKey(track: NowPlaying): string {
  return `${(track.title ?? "").toLowerCase().trim()}|${(track.artist ?? "").toLowerCase().trim()}`;
}

function loadOffsets(): OffsetCache {
  try {
    return JSON.parse(localStorage.getItem("ljay:mv-offsets") ?? "{}");
  } catch { return {}; }
}

function saveOffsets(o: OffsetCache): void {
  try { localStorage.setItem("ljay:mv-offsets", JSON.stringify(o)); } catch {}
}

export function create(): Vibe {
  let host: VibeHost | null = null;
  let video: HTMLVideoElement | null = null;
  let overlay: HTMLDivElement | null = null;
  let unsubState: (() => void) | null = null;
  let pollTimer: number | null = null;
  let unsubKeys: (() => void) | null = null;

  let currentTrackKey: string | null = null;
  let currentMv: MvState = { state: "idle" };
  let offsets: OffsetCache = loadOffsets();
  let activeOffset = 0; // ms — added to playhead before driving video.currentTime
  let userNudgedThisTrack = false;

  // Track latest state without re-rendering React-style; just snapshot.
  let nowPlaying: NowPlaying | null = null;
  let playhead: { positionMs: number; rate: number; anchorMs: number } | null = null;

  const lyricStyle: LyricStyle = {
    font: '"Inter", -apple-system, system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    shadow: "0 2px 18px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85)",
    animation: "snippet",
    snippetWindow: 2,
  };

  function setOverlayMessage(msg: string | null): void {
    if (!overlay) return;
    if (!msg) {
      overlay.style.display = "none";
      overlay.textContent = "";
    } else {
      overlay.style.display = "flex";
      overlay.textContent = msg;
    }
  }

  async function loadMvFor(track: NowPlaying): Promise<void> {
    const key = offsetKey(track);
    currentTrackKey = key;
    // If the user nudged this track before, that wins over auto-align;
    // otherwise we'll compute the auto offset on `loadedmetadata` below.
    activeOffset = offsets[key] ?? 0;
    userNudgedThisTrack = key in offsets;
    currentMv = { state: "idle" };
    setOverlayMessage(`Looking up music video for "${track.title}"…`);

    const params = new URLSearchParams();
    params.set("title", track.title);
    params.set("artist", track.artist);
    let attempts = 0;
    const tick = async () => {
      // If the user changed track mid-fetch, abort.
      if (currentTrackKey !== key) return;
      attempts++;
      try {
        const res = await fetch(`/mv?${params.toString()}`);
        const j = (await res.json()) as MvState;
        if (currentTrackKey !== key) return;
        currentMv = j;
        if (j.state === "ready") {
          setOverlayMessage(null);
          if (video) {
            if (video.src !== location.origin + j.url) {
              video.src = j.url;
            }
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            void video.play().catch(() => {});
          }
        } else if (j.state === "downloading") {
          setOverlayMessage(`Downloading music video (try ${attempts})…`);
          if (attempts < 90) pollTimer = window.setTimeout(tick, POLL_DOWNLOAD_MS);
        } else if (j.state === "error") {
          setOverlayMessage(`Music video unavailable: ${j.error}`);
        } else {
          setOverlayMessage(`Music video: ${j.state}`);
        }
      } catch (e) {
        setOverlayMessage(`Music video fetch failed: ${(e as Error).message}`);
      }
    };
    tick();
  }

  return {
    id: "mv",
    name: "Music video",
    lyricStyle,

    mount(h: VibeHost) {
      host = h;
      // Hide the WebGL canvas — we render the video on top of the container.
      h.canvas.style.display = "none";

      video = document.createElement("video");
      video.className = "ljay-mv-video";
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      video.autoplay = true;
      video.loop = false;
      video.preload = "auto";

      // Auto-sync trick: most official music videos end pretty much exactly
      // when the song ends, but begin earlier (intro footage). So:
      //   offset = videoDuration - trackDuration
      // gets you within a couple of seconds. The user's manual nudge for this
      // track (if any) overrides this.
      video.addEventListener("loadedmetadata", () => {
        if (!video || !nowPlaying) return;
        if (userNudgedThisTrack) return;
        const trackMs = nowPlaying.durationMs;
        if (!Number.isFinite(video.duration) || trackMs <= 0) return;
        const auto = (video.duration * 1000) - trackMs;
        // Only apply the auto-offset if it's plausible (positive and not absurd).
        if (auto > -1500 && auto < 60_000) {
          activeOffset = Math.max(0, auto);
        }
      });
      Object.assign(video.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        objectFit: "cover",
        background: "#000",
        zIndex: "1",
        pointerEvents: "none",
      } as CSSStyleDeclaration);
      h.container.appendChild(video);

      overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "absolute",
        inset: "0",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 6vw",
        color: "rgba(255,255,255,0.85)",
        font: '500 18px/1.4 -apple-system, system-ui, sans-serif',
        background: "rgba(0,0,0,0.65)",
        zIndex: "2",
        pointerEvents: "none",
      } as CSSStyleDeclaration);
      h.container.appendChild(overlay);

      // Watch app state for now-playing + playhead.
      unsubState = subscribe((s) => {
        playhead = s.playhead;
        const next = s.nowPlaying;
        const nextKey = next ? offsetKey(next) : null;
        if (nextKey !== currentTrackKey) {
          if (next) {
            nowPlaying = next;
            void loadMvFor(next);
          } else {
            nowPlaying = null;
            currentTrackKey = null;
            currentMv = { state: "idle" };
            if (video) video.removeAttribute("src");
            setOverlayMessage("(no track)");
          }
        } else {
          nowPlaying = next;
        }
      });

      // Hotkeys: [ / ] nudge the per-track offset by ±100 ms.
      const onKey = (e: KeyboardEvent) => {
        if (!nowPlaying) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        const delta = e.key === "[" ? -100 : e.key === "]" ? 100 : 0;
        if (delta === 0) return;
        e.preventDefault();
        activeOffset += delta;
        userNudgedThisTrack = true;
        offsets[offsetKey(nowPlaying)] = activeOffset;
        saveOffsets(offsets);
      };
      window.addEventListener("keydown", onKey);
      unsubKeys = () => window.removeEventListener("keydown", onKey);
    },

    update(_audio: AudioFrame | null, _dtMs: number) {
      if (!video || currentMv.state !== "ready" || !playhead) return;

      // Pitch follow.
      const targetRate = Math.max(0.0625, Math.min(16, playhead.rate || 1));
      if (Math.abs(video.playbackRate - targetRate) > 0.005) {
        video.playbackRate = targetRate;
      }
      // Pause if DJ paused.
      if (playhead.rate === 0) {
        if (!video.paused) video.pause();
        return;
      }
      if (video.paused && video.readyState >= 2) {
        void video.play().catch(() => {});
      }

      // Position follow with hysteresis: only hard-seek on big drift, else
      // let the video play forward naturally.
      const wantSec = Math.max(0, (playhead.positionMs + (performance.now() - playhead.anchorMs) * playhead.rate + activeOffset) / 1000);
      if (!isFinite(wantSec) || video.duration && wantSec > video.duration) return;
      const have = video.currentTime;
      const driftMs = Math.abs(have - wantSec) * 1000;
      if (driftMs > SYNC_DRIFT_MS) {
        try { video.currentTime = wantSec; } catch { /* ignore */ }
      }
    },

    unmount() {
      unsubState?.();
      unsubKeys?.();
      if (pollTimer != null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (video) {
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch {}
        video.remove();
        video = null;
      }
      overlay?.remove();
      overlay = null;
      if (host) host.canvas.style.display = "block";
      host = null;
      currentTrackKey = null;
      currentMv = { state: "idle" };
    },
  };
}
