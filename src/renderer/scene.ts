import type { AudioFrame, Vibe, VibeHost } from "../types.ts";

// Stage hosts a STACK of layered vibes. Each layer owns its own canvas (and
// thus its own GL context — butterchurn-WebGL1 + three.js-WebGL2 + a
// transparent overlay can all coexist this way) and the layers composite
// via DOM stacking with per-layer CSS `opacity`.
//
// Bottom-of-stack paints first (lowest z-index in the host), top last.
// Each layer's vibe still controls its own canvas's backing-store size and
// renderer; the Stage just creates the DOM canvas and tells vibes about
// CSS-pixel resizes.

interface StageLayer {
  id: string;
  vibe: Vibe;
  canvas: HTMLCanvasElement;
  host: VibeHost;
  resizeListeners: Set<(w: number, h: number) => void>;
}

export class Stage {
  private host: HTMLElement;
  private rafId: number | null = null;
  private lastT = 0;
  private latestFrame: AudioFrame | null = null;
  private decayedFrame: AudioFrame | null = null;
  private hasFreshFrame = false;
  private resizeObs: ResizeObserver;
  private width = 0;
  private height = 0;
  private reducedMotion = false;
  private layers: Map<string, StageLayer> = new Map();
  private order: string[] = []; // bottom-to-top

  constructor(host: HTMLElement) {
    this.host = host;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(host);
    window.addEventListener("resize", this.handleResize);
    this.handleResize();
  }

  private handleResize = () => {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this.width && h === this.height && this.layers.size > 0) return;
    this.width = w;
    this.height = h;
    for (const layer of this.layers.values()) {
      for (const cb of layer.resizeListeners) cb(w, h);
    }
  };

  /** True when the layer is currently mounted. */
  hasLayer(id: string): boolean {
    return this.layers.has(id);
  }

  /** Mount a vibe into a fresh canvas at the top of the stack. */
  async addLayer(id: string, vibe: Vibe): Promise<void> {
    if (this.layers.has(id)) return;
    const canvas = document.createElement("canvas");
    canvas.dataset.layerId = id;
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    this.host.appendChild(canvas);

    const stage = this;
    const layerResizeListeners = new Set<(w: number, h: number) => void>();
    const layerHost: VibeHost = {
      canvas,
      container: this.host,
      get width() { return stage.width; },
      get height() { return stage.height; },
      onResize(cb) {
        layerResizeListeners.add(cb);
        return () => layerResizeListeners.delete(cb);
      },
    };

    const layer: StageLayer = {
      id, vibe, canvas, host: layerHost,
      resizeListeners: layerResizeListeners,
    };
    this.layers.set(id, layer);
    this.order.push(id);

    try {
      await vibe.mount(layerHost);
    } catch (e) {
      console.error(`[stage] vibe.mount(${id}) failed`, e);
      this.layers.delete(id);
      this.order = this.order.filter((x) => x !== id);
      canvas.remove();
      throw e;
    }
  }

  /** Unmount the layer and remove its canvas. */
  removeLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    try { layer.vibe.unmount(); } catch (e) { console.error(`[stage] vibe.unmount(${id}) failed`, e); }
    layer.canvas.remove();
    this.layers.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  /** Set a CSS opacity on the layer's canvas. 0..1. */
  setLayerOpacity(id: string, opacity: number): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    const op = Math.max(0, Math.min(1, opacity));
    layer.canvas.style.opacity = String(op);
  }

  /** Reorder layers explicitly. IDs not in `order` are appended on top. */
  setLayerOrder(order: string[]): void {
    const known = new Set(this.layers.keys());
    const next = order.filter((id) => known.has(id));
    for (const id of this.order) if (!next.includes(id) && known.has(id)) next.push(id);
    this.order = next;
    // Re-append in the new order so DOM order matches z-order.
    for (const id of this.order) {
      const layer = this.layers.get(id);
      if (layer) this.host.appendChild(layer.canvas);
    }
  }

  /** Returns the current order, bottom-to-top. */
  layerOrder(): string[] {
    return this.order.slice();
  }

  feedAudio(frame: AudioFrame): void {
    this.latestFrame = frame;
    this.hasFreshFrame = true;
  }

  start(): void {
    if (this.rafId != null) return;
    this.lastT = performance.now();
    const tick = (t: number) => {
      this.rafId = requestAnimationFrame(tick);
      let dtMs = t - this.lastT;
      this.lastT = t;
      if (this.reducedMotion) dtMs *= 0.5;

      let frame: AudioFrame | null = null;
      if (this.hasFreshFrame && this.latestFrame) {
        frame = this.latestFrame;
        this.decayedFrame = { ...this.latestFrame };
        this.hasFreshFrame = false;
      } else if (this.decayedFrame) {
        const d = this.decayedFrame;
        const motionFactor = this.reducedMotion ? 0.5 : 1;
        d.bass *= 0.85;
        d.mid *= 0.85;
        d.treble *= 0.85;
        d.level *= 0.85;
        d.beat *= 0.85 * motionFactor;
        frame = d;
      }

      // Tick all layers in order (bottom first). They each render to their own
      // canvas; DOM stacking does the compositing.
      for (const id of this.order) {
        const layer = this.layers.get(id);
        if (!layer) continue;
        try { layer.vibe.update(frame, dtMs); }
        catch (e) { console.error(`[stage] vibe.update(${id})`, e); }
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.stop();
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    this.resizeObs.disconnect();
    window.removeEventListener("resize", this.handleResize);
  }
}
