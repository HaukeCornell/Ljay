import type { AppState, AudioFrame, LyricAnimation, LyricStyle, Vibe } from "./types";
import { getState, setState, subscribe } from "./state/store";
import { MediaRemoteSource, extrapolate } from "./sources/mediaRemoteSource";
import { LrclibResolver } from "./lyrics/lrclib";
import { LyricsCache } from "./lyrics/cache";
import { LyricsStore } from "./lyrics/store";
import { Stage } from "./renderer/scene";
import { listVibes, vibes as vibeFactories, AUTO_CYCLE_IDS } from "./vibes/registry";
import { LyricScene } from "./ui/lyricScene";
import { mountControlBar } from "./ui/controlBar";
import { WebAudioCapture } from "./audio/capture";
import { VideoLayer, type VideoMode } from "./ui/videoLayer";

const VIBE_LS_KEY = "ljay:vibe";
const LYRIC_MODE_LS_KEY = "ljay:lyric-mode";
const VIDEO_MODE_LS_KEY = "ljay:video-mode";
const DEFAULT_VIBE = "winamp";
const DEFAULT_LYRIC_MODE = "auto"; // "auto" = use vibe's own default
const DEFAULT_VIDEO_MODE = "off";

const VIDEO_MODES: ReadonlySet<VideoMode> = new Set([
  "off", "on", "screen", "multiply", "difference",
]);

const LYRIC_MODE_META: { id: string; name: string }[] = [
  { id: "auto",       name: "Auto (vibe default)" },
  { id: "particles",  name: "Particles (spectral field)" },
  { id: "spatial",    name: "Spatial 3D (fly-through)" },
  { id: "snippet",    name: "Snippet (word-windowed)" },
  { id: "karaoke",    name: "Karaoke (line wipe)" },
  { id: "subtitle",   name: "Subtitle (broadcast band)" },
  { id: "scroll",     name: "Scroll (line scroll)" },
  { id: "fade",       name: "Fade" },
  { id: "typewriter", name: "Typewriter" },
  { id: "bounce",     name: "Bounce" },
];

const LYRIC_ANIMATIONS: ReadonlySet<LyricAnimation> = new Set([
  "scroll", "typewriter", "fade", "bounce", "snippet", "spatial", "subtitle", "karaoke", "particles",
]);

function loadStoredVibe(): string {
  try { return localStorage.getItem(VIBE_LS_KEY) ?? DEFAULT_VIBE; }
  catch { return DEFAULT_VIBE; }
}
function storeVibe(id: string): void {
  try { localStorage.setItem(VIBE_LS_KEY, id); } catch {}
}
function loadStoredLyricMode(): string {
  try { return localStorage.getItem(LYRIC_MODE_LS_KEY) ?? DEFAULT_LYRIC_MODE; }
  catch { return DEFAULT_LYRIC_MODE; }
}
function storeLyricMode(id: string): void {
  try { localStorage.setItem(LYRIC_MODE_LS_KEY, id); } catch {}
}
function loadStoredVideoMode(): VideoMode {
  try {
    const v = localStorage.getItem(VIDEO_MODE_LS_KEY);
    if (v && VIDEO_MODES.has(v as VideoMode)) return v as VideoMode;
  } catch {}
  return DEFAULT_VIDEO_MODE as VideoMode;
}
function storeVideoMode(id: string): void {
  try { localStorage.setItem(VIDEO_MODE_LS_KEY, id); } catch {}
}

function pickRandomVibeId(excluding: string | null): string {
  const choices = AUTO_CYCLE_IDS.filter((id) => id !== excluding);
  return choices[Math.floor(Math.random() * choices.length)] ?? AUTO_CYCLE_IDS[0];
}

async function boot() {
  const stageHost = document.getElementById("stage")!;
  const lyricHost = document.getElementById("lyrics")!;
  const controlHost = document.getElementById("control-bar")!;

  // ---- renderer ----
  const stage = new Stage(stageHost);

  // ---- music-video overlay layer (independent of vibe selection) ----
  const videoLayer = new VideoLayer(stageHost);

  // ---- lyric overlay ----
  const lyricScene = new LyricScene(lyricHost);

  // ---- lyrics pipeline ----
  const lyricsStore = new LyricsStore(new LrclibResolver(), new LyricsCache());

  // ---- audio capture (best-effort; falls back to synthetic) ----
  // The vibe pipeline (via Stage) and the spatial lyric renderer both need
  // live AudioFrames. Stage decays stale frames internally; we mirror the
  // raw latest frame in `latestAudio` for the lyric layer to read each tick.
  let latestAudio: AudioFrame | null = null;
  const capture = new WebAudioCapture();
  capture.on((f) => {
    stage.feedAudio(f);
    latestAudio = f;
  });

  // ---- vibe management ----
  let activeVibe: Vibe | null = null;
  let activeVibeId = "";
  /** Whether the picker is in "Auto" mode. We track this separately from the
   * actually-rendered vibe so the picker UI can remain on "Auto" while the
   * rendered visualizer cycles per track. */
  let autoMode = false;

  function applyLyricStyle(): void {
    if (!activeVibe?.lyricStyle) return;
    const override = getState().lyricAnimationOverride;
    const finalStyle: LyricStyle = override
      ? { ...activeVibe.lyricStyle, animation: override }
      : activeVibe.lyricStyle;
    lyricScene.setStyle(finalStyle);
  }

  /** Mount a concrete vibe (no auto handling). */
  async function applyVibe(id: string): Promise<void> {
    if (id === activeVibeId) return;
    const factory = vibeFactories[id];
    if (!factory) return;
    const v = await factory();
    await stage.setVibe(v);
    activeVibe = v;
    activeVibeId = id;
    applyLyricStyle();
  }

  /** Top-level vibe handler — handles "auto" specially. */
  async function setVibeSelection(id: string): Promise<void> {
    if (id === "auto") {
      autoMode = true;
      setState({ autoVibe: true, currentVibe: "auto" });
      storeVibe("auto");
      // Pick something now if we don't have one yet, else keep what's showing.
      if (!activeVibeId) {
        await applyVibe(pickRandomVibeId(null));
      }
    } else {
      autoMode = false;
      setState({ autoVibe: false, currentVibe: id });
      storeVibe(id);
      await applyVibe(id);
    }
  }

  function setLyricMode(id: string): void {
    const override: LyricAnimation | null =
      id !== "auto" && LYRIC_ANIMATIONS.has(id as LyricAnimation)
        ? (id as LyricAnimation)
        : null;
    setState({ lyricAnimationOverride: override });
    storeLyricMode(id);
    applyLyricStyle();
  }

  // ---- track source ----
  const source = new MediaRemoteSource();
  let lastTrackKey = "";
  source.onStatus((s) => {
    setState({ source: s });
    bar.setStatus(s);
  });
  /** Apply a single control-plane mutation from the panel side. Recognised
   *  paths drive specific local state. Unknown paths are silently ignored
   *  (panel persists them anyway, so they survive reload). */
  function applyControlPath(path: string, value: unknown): void {
    if (path === "currentVibe" && typeof value === "string") {
      void setVibeSelection(value);
    } else if (path === "lyricAnimation" && typeof value === "string") {
      setLyricMode(value);
      bar.setLyricMode(value);
    } else if (path === "lyricsVisible" && typeof value === "boolean") {
      setState({ lyricsVisible: value });
      lyricScene.setVisible(value);
      bar.setLyricsVisible(value);
    } else if (path === "lyricsHold" && typeof value === "boolean") {
      setState({ lyricsHold: value });
      lyricScene.setHold(value);
      bar.setHold(value);
    } else if (path === "videoMode" && typeof value === "string") {
      setVideoMode(value);
      bar.setVideoMode(value);
    }
    // effectParams.<id>.* and lyricParams.<id>.* are persisted in the sidecar
    // for now but don't yet drive renderer state — the layer architecture
    // migration will unlock per-vibe param uniforms.
  }

  function applyControlSnapshot(state: Record<string, unknown>): void {
    if (state == null || typeof state !== "object") return;
    if (typeof state.currentVibe === "string") applyControlPath("currentVibe", state.currentVibe);
    if (typeof state.lyricAnimation === "string") applyControlPath("lyricAnimation", state.lyricAnimation);
    if (typeof state.lyricsVisible === "boolean") applyControlPath("lyricsVisible", state.lyricsVisible);
    if (typeof state.lyricsHold === "boolean") applyControlPath("lyricsHold", state.lyricsHold);
    if (typeof state.videoMode === "string") applyControlPath("videoMode", state.videoMode);
  }

  source.on((evt) => {
    if (evt.kind === "now-playing" && evt.track) {
      setState({ nowPlaying: evt.track });
      void lyricsStore.loadFor(evt.track);
      videoLayer.setTrack(evt.track);
      // Auto-VJ: pick a fresh vibe per new track.
      const trackKey = `${evt.track.title}|${evt.track.artist}`;
      if (autoMode && trackKey !== lastTrackKey) {
        void applyVibe(pickRandomVibeId(activeVibeId));
      }
      lastTrackKey = trackKey;
    } else if (evt.kind === "playhead" && evt.playhead) {
      setState({ playhead: evt.playhead });
    } else if (evt.kind === "link" && evt.link) {
      setState({ link: evt.link });
    } else if (evt.kind === "stopped") {
      setState({ nowPlaying: null, playhead: null });
      lyricsStore.clear();
      videoLayer.setTrack(null);
    } else if (evt.kind === "control-snapshot" && evt.state) {
      applyControlSnapshot(evt.state);
    } else if (evt.kind === "control-update" && evt.path !== undefined) {
      applyControlPath(evt.path, evt.value);
    }
  });

  // Mirror local control-bar changes into the WS so any panel sees them too.
  // Handlers below also call sendControlSet alongside their normal local apply.
  function pushControl(path: string, value: unknown): void {
    source.sendControlSet(path, value);
  }

  lyricsStore.on((lyrics) => setState({ lyrics }));

  function setVideoMode(id: string): void {
    const mode: VideoMode = VIDEO_MODES.has(id as VideoMode) ? (id as VideoMode) : "off";
    videoLayer.setMode(mode);
    storeVideoMode(mode);
  }

  // ---- control bar ----
  const bar = mountControlBar({
    host: controlHost,
    vibes: listVibes(),
    lyricModes: LYRIC_MODE_META,
    onVibeChange: (id) => {
      void setVibeSelection(id);
      pushControl("currentVibe", id);
    },
    onLyricModeChange: (id) => {
      setLyricMode(id);
      pushControl("lyricAnimation", id);
    },
    onVideoModeChange: (id) => {
      setVideoMode(id);
      pushControl("videoMode", id);
    },
    onLyricsToggle: (visible) => {
      setState({ lyricsVisible: visible });
      lyricScene.setVisible(visible);
      pushControl("lyricsVisible", visible);
    },
    onHoldToggle: (hold) => {
      setState({ lyricsHold: hold });
      lyricScene.setHold(hold);
      pushControl("lyricsHold", hold);
    },
  });

  // ---- state → UI projections ----
  const linkIndicator = document.getElementById("link-indicator");
  subscribe((s: AppState) => {
    if (s.nowPlaying) {
      bar.setNowPlaying(`${s.nowPlaying.title} — ${s.nowPlaying.artist || "?"}`);
    } else {
      bar.setNowPlaying("—");
    }
    // Picker always reflects the user's selection ("auto" or a specific id),
    // not the actually-rendered vibe (which can rotate underneath).
    bar.setVibe(s.currentVibe);

    // Link indicator: show only when at least one peer is connected (i.e.,
    // Djay's Link is on and broadcasting). Hidden otherwise.
    if (linkIndicator) {
      if (s.link && s.link.peers > 0) {
        linkIndicator.textContent = `${s.link.bpm.toFixed(1)} BPM · ${s.link.peers} peer${s.link.peers === 1 ? "" : "s"}${s.link.playing ? "" : " · paused"}`;
        linkIndicator.style.opacity = "1";
      } else {
        linkIndicator.style.opacity = "0";
      }
    }
  });

  // ---- per-frame lyric + video advance ----
  function tick() {
    const s = getState();
    const pos = extrapolate(s.playhead, performance.now());
    lyricScene.update(pos, s.lyrics?.lines ?? null, latestAudio, s.link);
    videoLayer.update(s.playhead);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- boot ----
  const storedVibe = loadStoredVibe();
  const storedLyricMode = loadStoredLyricMode();
  const storedVideoMode = loadStoredVideoMode();
  setLyricMode(storedLyricMode);
  bar.setLyricMode(storedLyricMode);
  setVideoMode(storedVideoMode);
  bar.setVideoMode(storedVideoMode);
  // Migrate old stored "mv" picker selection: MV is no longer a vibe.
  await setVibeSelection(storedVibe === "mv" ? DEFAULT_VIBE : storedVibe);
  stage.start();
  await source.start();

  // Audio capture must be started by a user gesture in some browsers.
  const armCapture = () => {
    void capture.start();
    window.removeEventListener("pointerdown", armCapture);
    window.removeEventListener("keydown", armCapture);
  };
  window.addEventListener("pointerdown", armCapture, { once: true });
  window.addEventListener("keydown", armCapture, { once: true });
}

boot().catch((e) => {
  console.error("[Ljay] boot failed", e);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="position:fixed;inset:auto 0 0 0;background:#400;color:#fff;padding:10px;margin:0;z-index:99;">Boot failed: ${String(e)}</pre>`,
  );
});
