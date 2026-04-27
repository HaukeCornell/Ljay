import type { AppState, AudioFrame, LyricAnimation, LyricStyle, Vibe } from "./types";
import { getState, setState, subscribe } from "./state/store";
import { MediaRemoteSource, extrapolate } from "./sources/mediaRemoteSource";
import { LrclibResolver } from "./lyrics/lrclib";
import { LyricsCache } from "./lyrics/cache";
import { LyricsStore } from "./lyrics/store";
import { Stage } from "./renderer/scene";
import { vibes as vibeFactories, AUTO_CYCLE_IDS } from "./vibes/registry";
import { LyricScene } from "./ui/lyricScene";
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

  // ---- layered vibe management ----
  // Multiple vibes can be enabled at once. Each becomes a Stage layer with
  // its own canvas/GL context. The "active" vibe (used for the lyric style
  // suggestion) is the last-enabled one — i.e. the topmost on the stack.
  const activeVibes = new Map<string, Vibe>();        // id -> mounted Vibe instance
  let topVibeId = "";                                  // id whose lyricStyle drives lyrics

  /** Whether the picker is in "Auto" mode. */
  let autoMode = false;

  // Panel-driven per-style overrides (color / accent / reactivity), keyed by
  // lyric style id. The active style's slice is forwarded to LyricScene
  // whenever it changes or the active animation switches.
  const lyricParamsByStyle: Record<string, { color?: string; accent?: string; reactivity?: number }> = {};

  function resolveActiveLyricAnimation(): string {
    const override = getState().lyricAnimationOverride;
    if (override) return override;
    const top = topVibeId ? activeVibes.get(topVibeId) : null;
    return top?.lyricStyle?.animation ?? "scroll";
  }

  function pushLyricOverridesForActive(): void {
    const id = resolveActiveLyricAnimation();
    const params = lyricParamsByStyle[id] ?? {};
    lyricScene.setOverrides({
      color: params.color,
      accent: params.accent,
      reactivity: params.reactivity,
    });
  }

  function applyLyricStyle(): void {
    const top = topVibeId ? activeVibes.get(topVibeId) : null;
    if (!top?.lyricStyle) return;
    const override = getState().lyricAnimationOverride;
    const finalStyle: LyricStyle = override
      ? { ...top.lyricStyle, animation: override }
      : top.lyricStyle;
    lyricScene.setStyle(finalStyle);
    pushLyricOverridesForActive();
  }

  function applyParamsToVibe(id: string, vibe: Vibe): void {
    if (!vibe.setParams) return;
    const cached = getState().effectParams[id];
    if (cached) {
      try { vibe.setParams(cached); }
      catch (e) { console.warn("[ljay] vibe.setParams threw", e); }
    }
  }

  function applyOpacityToLayer(id: string): void {
    const op = getState().effectParams[id]?.opacity;
    if (typeof op === "number") stage.setLayerOpacity(id, op);
  }

  /** Enable a single vibe layer (idempotent). */
  async function enableVibe(id: string): Promise<void> {
    if (activeVibes.has(id)) return;
    const factory = vibeFactories[id];
    if (!factory) return;
    const v = await factory();
    await stage.addLayer(id, v);
    activeVibes.set(id, v);
    topVibeId = id;
    applyParamsToVibe(id, v);
    applyOpacityToLayer(id);
    applyLyricStyle();
    setState({
      effectsEnabled: { ...getState().effectsEnabled, [id]: true },
      currentVibe: id,
    });
  }

  /** Disable a vibe layer (idempotent). */
  function disableVibe(id: string): void {
    if (!activeVibes.has(id)) return;
    stage.removeLayer(id);
    activeVibes.delete(id);
    if (topVibeId === id) {
      // Pick the new top: whichever's currently on top of the stage's order.
      const order = stage.layerOrder();
      topVibeId = order.length > 0 ? order[order.length - 1] : "";
      applyLyricStyle();
    }
    const next = { ...getState().effectsEnabled };
    delete next[id];
    setState({ effectsEnabled: next });
  }

  /** Top-bar shortcut: enable ONLY this vibe (disable everything else). */
  async function setVibeSelection(id: string): Promise<void> {
    if (id === "auto") {
      autoMode = true;
      setState({ autoVibe: true, currentVibe: "auto" });
      storeVibe("auto");
      if (activeVibes.size === 0) {
        await enableVibe(pickRandomVibeId(null));
      }
      return;
    }
    autoMode = false;
    setState({ autoVibe: false, currentVibe: id });
    storeVibe(id);
    // Disable other vibes first.
    for (const otherId of [...activeVibes.keys()]) {
      if (otherId !== id) disableVibe(otherId);
    }
    await enableVibe(id);
  }

  /** Toggle a single vibe layer in/out (the panel uses this for multi-stack). */
  async function setVibeEnabled(id: string, enabled: boolean): Promise<void> {
    if (enabled) await enableVibe(id);
    else disableVibe(id);
    autoMode = false;
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
    launcher.setStatus(s);
  });
  /** Apply a single control-plane mutation from the panel side. Recognised
   *  paths drive specific local state. Unknown paths are silently ignored
   *  (panel persists them anyway, so they survive reload). */
  function applyControlPath(path: string, value: unknown): void {
    if (path === "currentVibe" && typeof value === "string") {
      void setVibeSelection(value);
    } else if (path === "autoVibe" && typeof value === "boolean") {
      autoMode = value;
      setState({ autoVibe: value });
      if (value && activeVibes.size === 0) {
        void enableVibe(pickRandomVibeId(null));
      }
    } else if (path === "lyricAnimation" && typeof value === "string") {
      setLyricMode(value);
    } else if (path === "lyricsVisible" && typeof value === "boolean") {
      setState({ lyricsVisible: value });
      lyricScene.setVisible(value);
    } else if (path === "lyricsHold" && typeof value === "boolean") {
      setState({ lyricsHold: value });
      lyricScene.setHold(value);
    } else if (path === "videoMode" && typeof value === "string") {
      setVideoMode(value);
    } else if (path.startsWith("videoOffsetMs.") && typeof value === "number") {
      // Per-track offset: only apply when the keyed track is the current one.
      const trackKey = path.slice("videoOffsetMs.".length);
      const np = getState().nowPlaying;
      const currentKey = np ? `${(np.title ?? "").toLowerCase().trim()}|${(np.artist ?? "").toLowerCase().trim()}` : "";
      if (trackKey === currentKey) videoLayer.setOffsetMs(value);
    } else if (path.startsWith("effectsEnabled.") && typeof value === "boolean") {
      const vibeId = path.slice("effectsEnabled.".length);
      void setVibeEnabled(vibeId, value);
    } else if (path.startsWith("effectParams.")) {
      // effectParams.<vibeId>.<key>
      const parts = path.split(".");
      if (parts.length === 3) {
        const [, vibeId, key] = parts;
        const cur = getState().effectParams[vibeId] ?? {};
        const next: Record<string, unknown> = { ...cur, [key]: value };
        setState({ effectParams: { ...getState().effectParams, [vibeId]: next } });
        // Live-apply to the mounted vibe if present.
        const v = activeVibes.get(vibeId);
        if (v?.setParams && key !== "opacity" && key !== "enabled") {
          try { v.setParams({ [key]: value }); }
          catch (e) { console.warn("[ljay] vibe.setParams threw", e); }
        }
        // Opacity goes straight to the layer's CSS opacity.
        if (key === "opacity" && typeof value === "number") {
          stage.setLayerOpacity(vibeId, value);
        }
      }
    } else if (path.startsWith("lyricParams.")) {
      // lyricParams.<styleId>.<key>
      const parts = path.split(".");
      if (parts.length === 3) {
        const [, styleId, key] = parts;
        const cur = lyricParamsByStyle[styleId] ?? {};
        lyricParamsByStyle[styleId] = { ...cur, [key]: value };
        // If this style is the active animation right now, push to the scene.
        if (styleId === resolveActiveLyricAnimation()) {
          pushLyricOverridesForActive();
        }
      }
    }
    // lyricsOffsetMs is persisted in the sidecar but doesn't yet drive
    // renderer state — pending the lyric-offset pass.
  }

  function applyControlSnapshot(state: Record<string, unknown>): void {
    if (state == null || typeof state !== "object") return;
    // effectsEnabled goes first so the layer stack is set up before params apply.
    if (state.effectsEnabled && typeof state.effectsEnabled === "object") {
      const ee = state.effectsEnabled as Record<string, unknown>;
      for (const id of Object.keys(ee)) {
        if (typeof ee[id] === "boolean") applyControlPath(`effectsEnabled.${id}`, ee[id]);
      }
    } else if (typeof state.currentVibe === "string") {
      // Backward-compat snapshot from v0.13: only currentVibe was set.
      applyControlPath("currentVibe", state.currentVibe);
    }
    if (typeof state.autoVibe === "boolean") applyControlPath("autoVibe", state.autoVibe);
    if (typeof state.lyricAnimation === "string") applyControlPath("lyricAnimation", state.lyricAnimation);
    if (typeof state.lyricsVisible === "boolean") applyControlPath("lyricsVisible", state.lyricsVisible);
    if (typeof state.lyricsHold === "boolean") applyControlPath("lyricsHold", state.lyricsHold);
    if (typeof state.videoMode === "string") applyControlPath("videoMode", state.videoMode);
    if (state.videoOffsetMs && typeof state.videoOffsetMs === "object") {
      const m = state.videoOffsetMs as Record<string, unknown>;
      for (const k of Object.keys(m)) {
        if (typeof m[k] === "number") applyControlPath(`videoOffsetMs.${k}`, m[k]);
      }
    }
    // Replay all effectParams entries (so new vibes pick up their saved colors).
    if (state.effectParams && typeof state.effectParams === "object") {
      const ep = state.effectParams as Record<string, Record<string, unknown>>;
      for (const vibeId of Object.keys(ep)) {
        for (const k of Object.keys(ep[vibeId])) {
          applyControlPath(`effectParams.${vibeId}.${k}`, ep[vibeId][k]);
        }
      }
    }
    if (state.lyricParams && typeof state.lyricParams === "object") {
      const lp = state.lyricParams as Record<string, Record<string, unknown>>;
      for (const styleId of Object.keys(lp)) {
        for (const k of Object.keys(lp[styleId])) {
          applyControlPath(`lyricParams.${styleId}.${k}`, lp[styleId][k]);
        }
      }
    }
  }

  source.on((evt) => {
    if (evt.kind === "now-playing" && evt.track) {
      setState({ nowPlaying: evt.track });
      void lyricsStore.loadFor(evt.track);
      videoLayer.setTrack(evt.track);
      // Auto-VJ: pick a fresh vibe per new track.
      const trackKey = `${evt.track.title}|${evt.track.artist}`;
      if (autoMode && trackKey !== lastTrackKey) {
        const next = pickRandomVibeId(topVibeId);
        for (const otherId of [...activeVibes.keys()]) if (otherId !== next) disableVibe(otherId);
        void enableVibe(next);
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

  lyricsStore.on((lyrics) => setState({ lyrics }));

  function setVideoMode(id: string): void {
    const mode: VideoMode = VIDEO_MODES.has(id as VideoMode) ? (id as VideoMode) : "off";
    videoLayer.setMode(mode);
    storeVideoMode(mode);
  }

  // ---- launcher chip (renderer is visuals-only; everything else lives in
  //      /control.html which the panel page renders). The chip just shows a
  //      live connection dot + optional BPM and exposes hover buttons to open
  //      or share the panel URL. ----
  const launcher = mountLauncher();

  // ---- state → UI projections ----
  subscribe((s: AppState) => {
    if (s.link && s.link.peers > 0) {
      launcher.setBpm(s.link.bpm);
    } else {
      launcher.setBpm(null);
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
  // The control panel snapshot (when it arrives over WS) is authoritative for
  // user-facing selections. Local-storage picks just bootstrap the renderer
  // so something is on screen before the panel connects.
  const storedVibe = loadStoredVibe();
  const storedLyricMode = loadStoredLyricMode();
  const storedVideoMode = loadStoredVideoMode();
  setLyricMode(storedLyricMode);
  setVideoMode(storedVideoMode);
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

interface LauncherHandle {
  setStatus(s: "offline" | "connecting" | "connected"): void;
  setBpm(bpm: number | null): void;
}

function mountLauncher(): LauncherHandle {
  const root = document.getElementById("launcher")!;
  const bpmEl = root.querySelector<HTMLSpanElement>("#launcher-bpm")!;
  const openBtn = root.querySelector<HTMLButtonElement>("#launcher-open")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#launcher-copy")!;

  const panelUrl = (): string => `${window.location.origin}/control.html`;

  openBtn.addEventListener("click", () => {
    window.open(panelUrl(), "_blank", "noopener");
  });

  copyBtn.addEventListener("click", async () => {
    const original = copyBtn.textContent ?? "Copy URL";
    try {
      await navigator.clipboard.writeText(panelUrl());
      copyBtn.textContent = "Copied";
    } catch {
      // Fallback: select-and-prompt so the URL is at least visible.
      window.prompt("Panel URL", panelUrl());
    }
    window.setTimeout(() => { copyBtn.textContent = original; }, 1200);
  });

  return {
    setStatus(s) {
      root.classList.toggle("connected", s === "connected");
      root.classList.toggle("connecting", s === "connecting");
    },
    setBpm(bpm) {
      if (bpm === null) {
        bpmEl.style.display = "none";
        bpmEl.textContent = "";
      } else {
        bpmEl.style.display = "";
        bpmEl.textContent = `${bpm.toFixed(1)} BPM`;
      }
    },
  };
}
