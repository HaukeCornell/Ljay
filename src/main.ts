import type { AppState, NowPlaying, Vibe } from "./types";
import { getState, setState, subscribe } from "./state/store";
import { MediaRemoteSource, extrapolate } from "./sources/mediaRemoteSource";
import { LrclibResolver } from "./lyrics/lrclib";
import { LyricsCache } from "./lyrics/cache";
import { LyricsStore } from "./lyrics/store";
import { Stage } from "./renderer/scene";
import { listVibes, vibes as vibeFactories } from "./vibes/registry";
import { LyricScene } from "./ui/lyricScene";
import { mountControlBar } from "./ui/controlBar";
import { WebAudioCapture } from "./audio/capture";

const VIBE_LS_KEY = "ljay:vibe";
const DEFAULT_VIBE = "winamp";

function loadStoredVibe(): string {
  try {
    return localStorage.getItem(VIBE_LS_KEY) ?? DEFAULT_VIBE;
  } catch {
    return DEFAULT_VIBE;
  }
}

function storeVibe(id: string): void {
  try { localStorage.setItem(VIBE_LS_KEY, id); } catch {}
}

async function boot() {
  const stageHost = document.getElementById("stage")!;
  const lyricHost = document.getElementById("lyrics")!;
  const controlHost = document.getElementById("control-bar")!;

  // ---- renderer ----
  const stage = new Stage(stageHost);
  // start() is called AFTER the default vibe is mounted (see boot below).

  // ---- lyric overlay ----
  const lyricScene = new LyricScene(lyricHost);

  // ---- lyrics pipeline ----
  const lyricsStore = new LyricsStore(new LrclibResolver(), new LyricsCache());

  // ---- audio capture (best-effort; falls back to synthetic) ----
  const capture = new WebAudioCapture();
  capture.on((f) => stage.feedAudio(f));

  // ---- vibe management ----
  let activeVibe: Vibe | null = null;
  let activeVibeId = "";
  async function switchVibe(id: string) {
    if (id === activeVibeId) return;
    const factory = vibeFactories[id];
    if (!factory) return;
    const v = await factory();
    await stage.setVibe(v);
    activeVibe = v;
    activeVibeId = id;
    if (v.lyricStyle) lyricScene.setStyle(v.lyricStyle);
    setState({ currentVibe: id });
    storeVibe(id);
  }

  // ---- track source ----
  const source = new MediaRemoteSource();
  source.onStatus((s) => {
    setState({ source: s });
    bar.setStatus(s);
  });
  source.on((evt) => {
    if (evt.kind === "now-playing" && evt.track) {
      setState({ nowPlaying: evt.track });
      void lyricsStore.loadFor(evt.track);
    } else if (evt.kind === "playhead" && evt.playhead) {
      setState({ playhead: evt.playhead });
    } else if (evt.kind === "stopped") {
      setState({ nowPlaying: null, playhead: null });
      lyricsStore.clear();
    }
  });

  lyricsStore.on((lyrics) => setState({ lyrics }));

  // ---- control bar ----
  const bar = mountControlBar({
    host: controlHost,
    vibes: listVibes(),
    onVibeChange: (id) => void switchVibe(id),
    onLyricsToggle: (visible) => {
      setState({ lyricsVisible: visible });
      lyricScene.setVisible(visible);
    },
    onHoldToggle: (hold) => {
      setState({ lyricsHold: hold });
      lyricScene.setHold(hold);
    },
  });

  // ---- state → UI projections ----
  subscribe((s: AppState) => {
    if (s.nowPlaying) {
      bar.setNowPlaying(`${s.nowPlaying.title} — ${s.nowPlaying.artist || "?"}`);
    } else {
      bar.setNowPlaying("—");
    }
    bar.setVibe(s.currentVibe);
  });

  // ---- per-frame lyric advance ----
  function tick() {
    const s = getState();
    const pos = extrapolate(s.playhead, performance.now());
    lyricScene.update(pos, s.lyrics?.lines ?? null);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- boot ----
  await switchVibe(loadStoredVibe());
  stage.start();
  await source.start();
  // Audio capture must be started by a user gesture in some browsers; defer to first click.
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
