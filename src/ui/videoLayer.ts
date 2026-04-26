import type { NowPlaying, Playhead } from "../types";

// Music-video overlay layer. Independent of vibe selection: any vibe keeps
// rendering underneath; this layer just composites a synced <video> on top
// according to the active blend mode. When the video isn't ready (downloading,
// missing, error, paused), opacity stays 0 and the vibe shows fully.
//
// Blend modes are CSS mix-blend-mode; they let the video paint *with* the
// visualizer instead of just covering it.

export type VideoMode =
  | "off"
  | "on"        // full opacity, normal blend (covers the vibe)
  | "screen"    // brighten — adds video light over the vibe
  | "multiply"  // darken — vibe colours tint the video
  | "difference"; // psychedelic invert mix

interface MvStateReady { state: "ready"; videoId: string; url: string }
interface MvStateMsg   { state: "downloading" | "missing" | "idle" }
interface MvStateError { state: "error"; error: string }
type MvState = MvStateReady | MvStateMsg | MvStateError;

const SYNC_DRIFT_MS = 220;
const POLL_DOWNLOAD_MS = 1500;

interface OffsetCache { [trackKey: string]: number }

function offsetKey(track: NowPlaying): string {
  return `${(track.title ?? "").toLowerCase().trim()}|${(track.artist ?? "").toLowerCase().trim()}`;
}

function loadOffsets(): OffsetCache {
  try { return JSON.parse(localStorage.getItem("ljay:mv-offsets") ?? "{}"); }
  catch { return {}; }
}
function saveOffsets(o: OffsetCache): void {
  try { localStorage.setItem("ljay:mv-offsets", JSON.stringify(o)); } catch {}
}

const BLEND_CSS: Record<VideoMode, string> = {
  off:        "normal",
  on:         "normal",
  screen:     "screen",
  multiply:   "multiply",
  difference: "difference",
};

export class VideoLayer {
  private video: HTMLVideoElement;
  private overlay: HTMLDivElement;
  private mode: VideoMode = "off";
  private currentTrackKey: string | null = null;
  private currentMv: MvState = { state: "idle" };
  private offsets: OffsetCache = loadOffsets();
  private activeOffset = 0;
  private userNudgedThisTrack = false;
  private pollTimer: number | null = null;
  private nowPlaying: NowPlaying | null = null;
  private playhead: Playhead | null = null;

  constructor(private host: HTMLElement) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.controls = false;
    this.video.autoplay = true;
    this.video.loop = false;
    this.video.preload = "auto";
    Object.assign(this.video.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      background: "transparent",
      zIndex: "2",
      pointerEvents: "none",
      display: "none",
      opacity: "0",
      transition: "opacity 360ms ease-out",
      mixBlendMode: "normal",
    } as CSSStyleDeclaration);
    host.appendChild(this.video);

    this.overlay = document.createElement("div");
    Object.assign(this.overlay.style, {
      position: "absolute",
      left: "12px",
      bottom: "12px",
      display: "none",
      padding: "6px 10px",
      color: "rgba(255,255,255,0.78)",
      font: '500 12px/1.2 -apple-system, system-ui, sans-serif',
      background: "rgba(0,0,0,0.55)",
      backdropFilter: "blur(6px)",
      borderRadius: "6px",
      zIndex: "3",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    host.appendChild(this.overlay);

    // Per-track offset hotkeys: [ / ] nudge ±100ms, only effective when video on.
    window.addEventListener("keydown", (e) => {
      if (this.mode === "off") return;
      if (!this.nowPlaying) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const delta = e.key === "[" ? -100 : e.key === "]" ? 100 : 0;
      if (delta === 0) return;
      e.preventDefault();
      this.activeOffset += delta;
      this.userNudgedThisTrack = true;
      this.offsets[offsetKey(this.nowPlaying)] = this.activeOffset;
      saveOffsets(this.offsets);
    });

    // Auto-align using duration-end heuristic when video metadata is known.
    this.video.addEventListener("loadedmetadata", () => {
      if (!this.nowPlaying || this.userNudgedThisTrack) return;
      const trackMs = this.nowPlaying.durationMs;
      if (!Number.isFinite(this.video.duration) || trackMs <= 0) return;
      const auto = (this.video.duration * 1000) - trackMs;
      if (auto > -1500 && auto < 60_000) {
        this.activeOffset = Math.max(0, auto);
      }
    });
  }

  /** Direct override of the per-track sync offset, used by the control panel's
   *  Video Sync slider. Persists through the same per-track cache as the
   *  hotkey nudges. */
  setOffsetMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.activeOffset = ms;
    this.userNudgedThisTrack = true;
    if (this.nowPlaying) {
      this.offsets[offsetKey(this.nowPlaying)] = ms;
      saveOffsets(this.offsets);
    }
  }

  setMode(mode: VideoMode): void {
    if (mode === this.mode) return;
    const wasOff = this.mode === "off";
    this.mode = mode;
    if (mode === "off") {
      this.video.style.display = "none";
      this.overlay.style.display = "none";
      try { this.video.pause(); } catch {}
    } else {
      this.video.style.display = "";
      this.video.style.mixBlendMode = BLEND_CSS[mode];
      // Coming from off → start a fetch for the current track now.
      if (wasOff && this.nowPlaying) this.loadFor(this.nowPlaying);
    }
  }

  setTrack(track: NowPlaying | null): void {
    this.nowPlaying = track;
    if (!track) {
      this.currentTrackKey = null;
      this.currentMv = { state: "idle" };
      try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch {}
      this.setOverlayMessage(null);
      return;
    }
    const key = offsetKey(track);
    if (key === this.currentTrackKey && this.currentMv.state === "ready") return;
    this.currentTrackKey = key;
    this.userNudgedThisTrack = key in this.offsets;
    this.activeOffset = this.offsets[key] ?? 0;
    if (this.mode === "off") return; // Don't burn a yt-dlp fetch when off.
    this.loadFor(track);
  }

  /** Drive video position/rate from the playhead. Called every frame. */
  update(playhead: Playhead | null): void {
    this.playhead = playhead;
    if (this.mode === "off") return;

    // Cross-fade: video visible only when truly playable. Fallback (vibe) shows
    // through whenever this is 0.
    const ready = this.currentMv.state === "ready"
      && this.video.readyState >= 3 /* HAVE_FUTURE_DATA */
      && !this.video.paused;
    const wantOpacity = ready ? "1" : "0";
    if (this.video.style.opacity !== wantOpacity) this.video.style.opacity = wantOpacity;

    if (this.currentMv.state !== "ready" || !playhead) return;

    const targetRate = Math.max(0.0625, Math.min(16, playhead.rate || 1));
    if (Math.abs(this.video.playbackRate - targetRate) > 0.005) {
      this.video.playbackRate = targetRate;
    }
    if (playhead.rate === 0) {
      if (!this.video.paused) this.video.pause();
      return;
    }
    if (this.video.paused && this.video.readyState >= 2) {
      void this.video.play().catch(() => {});
    }
    const wantSec = Math.max(0,
      (playhead.positionMs + (performance.now() - playhead.anchorMs) * playhead.rate + this.activeOffset) / 1000);
    if (!isFinite(wantSec) || (this.video.duration && wantSec > this.video.duration)) return;
    const driftMs = Math.abs(this.video.currentTime - wantSec) * 1000;
    if (driftMs > SYNC_DRIFT_MS) {
      try { this.video.currentTime = wantSec; } catch {}
    }
  }

  // ---- internals ----

  private setOverlayMessage(msg: string | null): void {
    if (!msg) {
      this.overlay.style.display = "none";
      this.overlay.textContent = "";
    } else {
      this.overlay.style.display = "";
      this.overlay.textContent = msg;
    }
  }

  private async loadFor(track: NowPlaying): Promise<void> {
    if (this.pollTimer != null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const key = offsetKey(track);
    const params = new URLSearchParams();
    params.set("title", track.title);
    params.set("artist", track.artist);
    let attempts = 0;
    const tick = async () => {
      if (this.currentTrackKey !== key) return;
      attempts++;
      try {
        const res = await fetch(`/mv?${params.toString()}`);
        const j = (await res.json()) as MvState;
        if (this.currentTrackKey !== key) return;
        this.currentMv = j;
        if (j.state === "ready") {
          this.setOverlayMessage(null);
          if (this.video.src !== location.origin + j.url) {
            this.video.src = j.url;
          }
          this.video.muted = true;
          void this.video.play().catch(() => {});
        } else if (j.state === "downloading") {
          this.setOverlayMessage(`Downloading music video… (${attempts})`);
          if (attempts < 90) this.pollTimer = window.setTimeout(tick, POLL_DOWNLOAD_MS);
        } else if (j.state === "error") {
          this.setOverlayMessage(`Music video unavailable: ${j.error}`);
        } else {
          this.setOverlayMessage(`Music video: ${j.state}`);
        }
      } catch (e) {
        this.setOverlayMessage(`Music video fetch failed: ${(e as Error).message}`);
      }
    };
    tick();
  }
}
