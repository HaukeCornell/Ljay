// Control-panel state hook backed by the sidecar WebSocket.
//
// Replaces the design's local-only `useVjay` hook. Optimistic local mutations
// are pushed to the sidecar; any reconciling broadcast (control-update or
// control-snapshot) is reflected back into the same store.
//
// The shape returned by `useControlState()` is a superset of what the design's
// `useVjay()` returned, so Panel.tsx can consume it almost without translation.

import { useEffect, useState } from "preact/hooks";
import {
  EFFECTS,
  LYRIC_STYLES,
  type EffectParamsDefaults,
} from "./catalog";
import type { LinkState, NowPlaying, Playhead } from "../types";
import { setLiveAudio, type PreviewAudioFrame } from "./tick";

// ─── Control-state shape on the wire ────────────────────────────────────────
//
// All fields are optional in the snapshot the sidecar persists — the panel
// fills any missing slots from defaults at read time. We DO NOT mirror the
// snapshot directly into a typed object; instead we stash it as a nested
// untyped tree and provide typed accessors.

type ControlSnapshot = {
  /** Legacy single-select; superseded by `effectsEnabled`. Retained so older
   *  sidecar snapshots still drive sensible behavior. */
  currentVibe?: string;
  /** Multi-toggle: which effect ids are mounted as Stage layers right now. */
  effectsEnabled?: Record<string, boolean>;
  /** Auto-VJ: cycles vibe on every track change. */
  autoVibe?: boolean;
  lyricAnimation?: string;
  lyricsVisible?: boolean;
  /** Hold-mode: already-sung words stay visible on screen. */
  lyricsHold?: boolean;
  videoMode?: string;
  effectParams?: Record<string, Partial<EffectParams>>;
  lyricParams?: Record<string, Partial<EffectParams>>;
  lyricsOffsetMs?: number;
  videoOffsetMs?: Record<string, number>;
};

export interface EffectParams extends EffectParamsDefaults {
  /** 0..1 panel-side opacity. Persists per effect id. */
  opacity?: number;
  /** The customize popup may write extra fields we don't model explicitly. */
  [key: string]: unknown;
}

// ─── Wire types (mirror sidecar/index.mjs) ──────────────────────────────────

type WsEvent =
  | { kind: "now-playing"; track: NowPlaying; seq: number }
  | { kind: "playhead"; playhead: Playhead; seq: number }
  | { kind: "stopped"; seq: number }
  | { kind: "link"; link: LinkState; seq: number }
  | { kind: "control-snapshot"; state: ControlSnapshot; seq: number }
  | { kind: "control-update"; path: string; value: unknown; seq: number };

// ─── Singleton WebSocket client ─────────────────────────────────────────────

type Listener = (s: ControlState) => void;

export interface ControlState {
  /** True once the sidecar has sent its initial snapshot. */
  ready: boolean;
  snapshot: ControlSnapshot;
  nowPlaying: NowPlaying | null;
  playhead: Playhead | null;
  link: LinkState | null;
  /** Track playback stopped (no current selection on Djay). */
  stopped: boolean;
}

const initial: ControlState = {
  ready: false,
  snapshot: {},
  nowPlaying: null,
  playhead: null,
  link: null,
  stopped: false,
};

let store: ControlState = initial;
const listeners = new Set<Listener>();

function setStore(patch: Partial<ControlState>): void {
  store = { ...store, ...patch };
  for (const l of listeners) l(store);
}

function setSnapshot(next: ControlSnapshot): void {
  setStore({ snapshot: next, ready: true });
}

/** Set a dotted path inside the snapshot, returning a fresh tree. */
function applyPath(snap: ControlSnapshot, path: string, value: unknown): ControlSnapshot {
  const parts = path.split(".");
  // Deep-copy the spine that we mutate; leaves can be shared.
  const out: Record<string, unknown> = { ...(snap as Record<string, unknown>) };
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const existing = cursor[k];
    const next: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[k] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
  return out as ControlSnapshot;
}

// ─── WebSocket connection management ────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function wsUrl(): string {
  // Same-origin /ws — Vite proxies to ws://127.0.0.1:7777.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function connect(): void {
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    console.warn("[control] ws ctor failed:", e);
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
  });
  ws.addEventListener("message", (ev) => {
    let msg: WsEvent;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as WsEvent;
    } catch {
      return;
    }
    handleEvent(msg);
  });
  ws.addEventListener("close", () => {
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    // close handler will run after; nothing to do here.
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(8000, 250 * Math.pow(2, reconnectAttempt));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleEvent(msg: WsEvent): void {
  switch (msg.kind) {
    case "now-playing":
      setStore({ nowPlaying: msg.track, stopped: false });
      break;
    case "playhead":
      setStore({ playhead: msg.playhead, stopped: false });
      break;
    case "stopped":
      setStore({ stopped: true });
      break;
    case "link":
      setStore({ link: msg.link });
      break;
    case "control-snapshot":
      setSnapshot(msg.state ?? {});
      break;
    case "control-update":
      setSnapshot(applyPath(store.snapshot, msg.path, msg.value));
      break;
  }
}

function startConnection(): void {
  if (started) return;
  started = true;
  connect();
}

/** Push a single path mutation to the sidecar. Fire-and-forget. */
export function setControlPath(path: string, value: unknown): void {
  // Optimistic local update first.
  setSnapshot(applyPath(store.snapshot, path, value));
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ kind: "control-set", path, value }));
    } catch {
      /* ignore — we'll reconcile on next snapshot */
    }
  }
}

/** Tell the sidecar to clear all control state. The sidecar replies with a
 *  fresh empty snapshot which every connected peer applies. */
export function resetControlState(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ kind: "control-reset" })); } catch { /* ignore */ }
  }
  // Optimistic local clear; the sidecar's snapshot will overwrite shortly.
  setSnapshot({});
}

// ─── Live preview audio: derive from Link when available ───────────────────
//
// When the sidecar reports a Link snapshot we can drive `setLiveAudio()` so
// the preview cards pulse on the real beat instead of the synthetic 105 BPM.
// We don't yet have FFT data flowing through the WS, so bass/mid/treble stay
// synthetic; only `t` and `beat` are derived from Link.

function startLinkBridge(): void {
  let raf = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const link = store.link;
    if (!link || link.peers <= 0 || link.bpm <= 0) {
      setLiveAudio(null);
      return;
    }
    const now = performance.now();
    const dtSec = (now - link.anchorMs) / 1000;
    const beatPos = link.beat + (dtSec * link.bpm) / 60;
    const phase = beatPos - Math.floor(beatPos); // 0..1 within the beat
    // Same shape as the synthetic source: sin^4 envelope around each beat.
    const beatEnvelope = Math.pow(Math.max(0, Math.sin(phase * Math.PI)), 4);
    const audio: PreviewAudioFrame = {
      t: now / 1000,
      beat: beatEnvelope,
      bass: 0.4 + 0.4 * beatEnvelope + 0.2 * Math.sin(now / 800),
      mid: 0.3 + 0.3 * Math.sin(now / 500 + 1),
      treble: 0.2 + 0.3 * Math.abs(Math.sin(now / 200 + 2)),
    };
    setLiveAudio(audio);
  };
  raf = requestAnimationFrame(tick);
  // We never tear this down — module lives for the page lifetime.
  void raf;
}
let bridgeStarted = false;

// ─── Public hook ────────────────────────────────────────────────────────────

export interface UseControlStateResult extends ControlState {
  /** Convenience: derived seconds elapsed into the current track. */
  elapsedSec: number;
  /** Convenience: total track duration in seconds. */
  durationSec: number;
  /** Convenience: BPM derived from Link if peers > 0, else null. */
  bpm: number | null;
  /** Convenience: 0..1 beat-onset envelope from Link, else synthetic 105 BPM. */
  beatPulse: number;
  /** Resolved snapshot field with default fallback. */
  currentVibe: string;
  /** True iff the named effect is mounted as a layer right now. */
  isEffectEnabled: (id: string) => boolean;
  /** Auto-VJ active — renderer cycles vibe on each new track. */
  autoVibe: boolean;
  lyricAnimation: string;
  lyricsVisible: boolean;
  /** Already-sung words stay on screen instead of fading out. */
  lyricsHold: boolean;
  videoMode: string;
  /** Returns merged params for an effect id (catalog defaults + snapshot). */
  effectParams: (id: string) => EffectParams;
  /** Returns merged params for a lyric id (catalog defaults + snapshot). */
  lyricParams: (id: string) => EffectParams;
  /** Lyrics offset (ms) — placeholder until renderer hookup. */
  lyricsOffsetMs: number;
  /** Per-track music-video offset for the active track key. */
  videoOffsetMs: number;
  /** Cache key used for `videoOffsetMs.<key>`. Empty string when no track. */
  videoTrackKey: string;
}

function videoTrackKeyOf(np: NowPlaying | null): string {
  if (!np) return "";
  // Matches the existing localStorage cache shape for music-video offset.
  return `${(np.title || "").toLowerCase().trim()}|${(np.artist || "").toLowerCase().trim()}`;
}

function effectDefaultsOf(id: string): EffectParams {
  const e = EFFECTS.find((x) => x.id === id);
  if (e) return { ...e.defaults, opacity: 1 };
  return { color: "#7cffb2", accent: "#000000", reactivity: 1, opacity: 1 };
}

function lyricDefaultsOf(id: string): EffectParams {
  const l = LYRIC_STYLES.find((x) => x.id === id);
  if (l) return { ...l.defaults };
  return { color: "#ffffff", accent: "#000000", reactivity: 0.5 };
}

export function useControlState(): UseControlStateResult {
  startConnection();
  if (!bridgeStarted) {
    bridgeStarted = true;
    startLinkBridge();
  }
  const [s, setS] = useState<ControlState>(store);
  useEffect(() => {
    const l: Listener = (next) => setS(next);
    listeners.add(l);
    // Push the latest store state immediately so a re-mounted hook isn't stale.
    setS(store);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Derived values.
  const np = s.nowPlaying;
  const ph = s.playhead;
  const durationSec = np ? np.durationMs / 1000 : 0;
  const elapsedSec = (() => {
    if (!ph) return 0;
    const drift = (performance.now() - ph.anchorMs) / 1000;
    const sec = ph.positionMs / 1000 + drift * ph.rate;
    if (durationSec > 0) return Math.min(durationSec, Math.max(0, sec));
    return Math.max(0, sec);
  })();

  const bpm = s.link && s.link.peers > 0 ? s.link.bpm : null;
  const beatPulse = (() => {
    if (s.link && s.link.peers > 0 && s.link.bpm > 0) {
      const now = performance.now();
      const dtSec = (now - s.link.anchorMs) / 1000;
      const beatPos = s.link.beat + (dtSec * s.link.bpm) / 60;
      const phase = beatPos - Math.floor(beatPos);
      return Math.pow(Math.max(0, Math.sin(phase * Math.PI)), 4);
    }
    // Fallback: synthetic 105 BPM matched to the design's Header.
    const phase = (performance.now() / 1000) * (105 / 60);
    return Math.abs(Math.sin(phase * Math.PI));
  })();

  const snap = s.snapshot;
  const effectsEnabled = snap.effectsEnabled ?? {};
  // Legacy fallback: if no effectsEnabled but currentVibe is set, treat that
  // single vibe as enabled.
  const isEffectEnabled = (id: string): boolean => {
    if (effectsEnabled[id] !== undefined) return effectsEnabled[id] === true;
    return snap.currentVibe === id;
  };
  const currentVibe = snap.currentVibe ?? "halftone";
  const autoVibe = snap.autoVibe ?? false;
  const lyricAnimation = snap.lyricAnimation ?? "auto";
  const lyricsVisible = snap.lyricsVisible ?? true;
  const lyricsHold = snap.lyricsHold ?? false;
  const videoMode = snap.videoMode ?? "off";

  const effectParams = (id: string): EffectParams => {
    const def = effectDefaultsOf(id);
    const set = snap.effectParams?.[id] ?? {};
    return { ...def, ...set };
  };
  const lyricParams = (id: string): EffectParams => {
    const def = lyricDefaultsOf(id);
    const set = snap.lyricParams?.[id] ?? {};
    return { ...def, ...set };
  };

  const lyricsOffsetMs = snap.lyricsOffsetMs ?? 0;
  const videoTrackKey = videoTrackKeyOf(np);
  const videoOffsetMs =
    videoTrackKey && snap.videoOffsetMs ? (snap.videoOffsetMs[videoTrackKey] ?? 0) : 0;

  return {
    ...s,
    elapsedSec,
    durationSec,
    bpm,
    beatPulse,
    currentVibe,
    isEffectEnabled,
    autoVibe,
    lyricAnimation,
    lyricsVisible,
    lyricsHold,
    videoMode,
    effectParams,
    lyricParams,
    lyricsOffsetMs,
    videoOffsetMs,
    videoTrackKey,
  };
}
