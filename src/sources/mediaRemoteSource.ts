import type {
  NowPlaying,
  Playhead,
  TrackSource,
  TrackSourceEvent,
} from "../types";

type Listener = (e: TrackSourceEvent) => void;

interface SidecarMsg extends TrackSourceEvent {}

/** Default sidecar WebSocket. We auto-detect: when the page is served from
 * the same host as the sidecar (Vite proxy at /ws) we use a relative URL so
 * the iPad-side panel and the local renderer both work without surgery. */
function defaultWsUrl(): string {
  if (typeof window !== "undefined") {
    // If served by Vite (same origin as the sidecar via /ws proxy), use it.
    // Otherwise fall back to localhost on the sidecar's hard-coded port.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return "ws://127.0.0.1:7777";
}
const DEFAULT_URL = "ws://127.0.0.1:7777";
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 4000];

export class MediaRemoteSource implements TrackSource {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private stopped = false;
  private statusListeners = new Set<
    (s: "offline" | "connecting" | "connected") => void
  >();

  constructor(private url: string = defaultWsUrl()) {
    void DEFAULT_URL;
  }

  /** Send a `control-set` message to the sidecar so it broadcasts to all
   *  panels (and our own renderer applies the update via the same WS echo). */
  sendControlSet(path: string, value: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ kind: "control-set", path, value })); }
      catch { /* ignore */ }
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: "offline" | "connecting" | "connected") => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  /** Replace `Playhead.anchorMs` from the sidecar's clock with our own
   * performance.now(), so future extrapolation in the renderer uses the
   * same wall clock the requestAnimationFrame loop reads. */
  private rebaseAnchor(p: Playhead): Playhead {
    return { ...p, anchorMs: performance.now() };
  }

  private rebaseLinkAnchor<T extends { anchorMs: number }>(l: T): T {
    return { ...l, anchorMs: performance.now() };
  }

  private emitStatus(s: "offline" | "connecting" | "connected") {
    for (const l of this.statusListeners) l(s);
  }

  private connect() {
    if (this.stopped) return;
    this.emitStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.emitStatus("connected");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as SidecarMsg;
        if (msg.playhead) msg.playhead = this.rebaseAnchor(msg.playhead);
        if (msg.link)     msg.link = this.rebaseLinkAnchor(msg.link);
        for (const l of this.listeners) l(msg);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.emitStatus("offline");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.retry, RECONNECT_BACKOFF_MS.length - 1)];
    this.retry++;
    setTimeout(() => this.connect(), delay);
  }
}

/** Compute the live position from a Playhead using the local clock. */
export function extrapolate(p: Playhead | null, nowMs: number): number {
  if (!p) return 0;
  return p.positionMs + (nowMs - p.anchorMs) * p.rate;
}

export type { NowPlaying };
