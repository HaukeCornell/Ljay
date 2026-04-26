// ============================================================
// Ljay shared contracts.
// Every module talks to its neighbors only through these types.
// Anything not listed here is an internal detail of the module
// that owns it.
// ============================================================

/** A track currently playing on the master output, as reported by the source. */
export interface NowPlaying {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  /** Best-effort identifier from the source (MediaRemote `UniqueIdentifier`, Spotify URI, etc). */
  sourceId?: string;
  /** Base64-encoded artwork blob if the source provided one. */
  artworkDataUrl?: string;
}

/** A continuously updated playhead estimate. The source extrapolates between
 * polls using the system clock so the renderer never has to interpolate. */
export interface Playhead {
  /** Position into the track in ms, already extrapolated to "now". */
  positionMs: number;
  /** 1.0 = normal speed, 0 = paused, 1.05 = +5% pitch. */
  rate: number;
  /** Wall-clock ms (performance.now()) the position is anchored to. */
  anchorMs: number;
}

/** Live Ableton Link snapshot, captured at the sidecar and rebased to the
 * renderer's `performance.now()` clock. The renderer extrapolates phase
 * forward locally between updates using `bpm`. */
export interface LinkState {
  /** Tempo in beats per minute. 0 if no peer is broadcasting. */
  bpm: number;
  /** Beat phase modulo `quantum`, in [0, quantum). */
  phase: number;
  /** Absolute beat count (modulo quantum) at `anchorMs`. */
  beat: number;
  /** Quantum the helper is using. Default 4 (one bar in 4/4). */
  quantum: number;
  /** Number of Link peers currently in the session. 0 = Djay Link off. */
  peers: number;
  /** True when the session transport is "playing". */
  playing: boolean;
  /** performance.now() at the moment the snapshot was captured. */
  anchorMs: number;
}

/** Composite event emitted by every TrackSource. Renderer is free to ignore
 * fields it does not yet consume. */
export interface TrackSourceEvent {
  kind: "now-playing" | "playhead" | "stopped" | "link";
  track?: NowPlaying;
  playhead?: Playhead;
  link?: LinkState;
  /** Monotonic counter so the consumer can detect dropped events. */
  seq: number;
}

/** Anything that can tell us what is playing. */
export interface TrackSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(listener: (e: TrackSourceEvent) => void): () => void;
}

// ---------- Lyrics ----------

export interface LyricLine {
  /** Start time within the track, in ms. */
  startMs: number;
  /** End time within the track, in ms. Optional; defaults to next line's start. */
  endMs?: number;
  text: string;
  /** Optional per-word timing (Spotify / enhanced LRC). */
  words?: { startMs: number; text: string }[];
}

export interface Lyrics {
  trackKey: string; // `${title}|${artist}` lowered
  source: "lrclib" | "spotify" | "manual" | "none";
  lines: LyricLine[];
  /** True if the source guarantees timestamps; false = plain text we faked timing for. */
  synced: boolean;
}

export interface LyricsResolver {
  resolve(track: NowPlaying): Promise<Lyrics | null>;
}

// ---------- Audio analysis ----------

/** Real-time audio features pumped into vibe shaders. */
export interface AudioFrame {
  /** Time the frame was captured, performance.now(). */
  t: number;
  bass: number; // 0..1
  mid: number; // 0..1
  treble: number; // 0..1
  /** RMS-ish loudness, 0..1. */
  level: number;
  /** Goes briefly to 1 on transient onsets, else 0. */
  beat: number;
  /** Raw FFT magnitudes if the vibe wants them. Length 512. */
  fft?: Float32Array;
}

export interface AudioCapture {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(listener: (f: AudioFrame) => void): () => void;
}

// ---------- Vibes ----------

/** A vibe owns its own three.js subtree (or DOM) and its own animation loop hook.
 * The host calls `update(audio, t)` each frame. */
export interface Vibe {
  id: string;
  name: string;
  /** Called once when activated; receives the host canvas + WebGL context info. */
  mount(host: VibeHost): void | Promise<void>;
  /** Called every frame. Audio frame may be null if capture is offline. */
  update(audio: AudioFrame | null, dtMs: number): void;
  /** Called when the vibe is swapped out or the app shuts down. */
  unmount(): void;
  /** Optional — vibes may suggest a lyric font/animation. */
  lyricStyle?: LyricStyle;
}

export interface VibeHost {
  canvas: HTMLCanvasElement;
  /** The DOM element the canvas lives inside. DOM-based vibes (e.g. video)
   *  attach their own elements here and may hide the canvas. */
  container: HTMLElement;
  width: number;
  height: number;
  /** Resize hook, host calls this when layout changes. */
  onResize(cb: (w: number, h: number) => void): () => void;
}

export interface LyricStyle {
  font: string; // CSS font-family stack
  weight: number;
  /** Foreground color (hex/rgba). */
  color: string;
  /** Optional text-shadow / glow CSS. */
  shadow?: string;
  /** Animation flavor for line transitions. */
  animation: LyricAnimation;
  uppercase?: boolean;
  /** For "snippet" mode: max visible words on each side of the current word. */
  snippetWindow?: number;
}

// ---------- App state ----------

export type LyricAnimation = "scroll" | "typewriter" | "fade" | "bounce" | "snippet" | "spatial" | "subtitle" | "karaoke" | "particles";

export interface AppState {
  source: "offline" | "connecting" | "connected";
  nowPlaying: NowPlaying | null;
  playhead: Playhead | null;
  lyrics: Lyrics | null;
  /** Latest Ableton Link snapshot if Djay's Link toggle is on; null otherwise. */
  link: LinkState | null;
  currentVibe: string;
  lyricsVisible: boolean;
  /** Hold-mode: already-sung words stay visible on screen instead of fading out. */
  lyricsHold: boolean;
  /** When set, overrides the active vibe's lyricStyle.animation; null = use vibe default. */
  lyricAnimationOverride: LyricAnimation | null;
  /** Auto-VJ: cycles vibe on every track change. */
  autoVibe: boolean;
}
