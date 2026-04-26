import * as THREE from "three";
import type { AudioFrame, Vibe, VibeHost } from "../types.ts";

// Stage owns the canvas. It does NOT keep a WebGLRenderer because each vibe
// constructs its own renderer (butterchurn especially needs to own its GL context).
// Only one GL context can live on a canvas at a time, and once a context is taken
// it cannot be cleanly handed off — so the Stage stays out of GL entirely.
// Caller MUST mount a vibe before calling start().

export class Stage {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private vibe: Vibe | null = null;
  private rafId: number | null = null;
  private lastT = 0;
  private latestFrame: AudioFrame | null = null;
  private decayedFrame: AudioFrame | null = null;
  private hasFreshFrame = false;
  private resizeObs: ResizeObserver;
  private resizeListeners = new Set<(w: number, h: number) => void>();
  private width = 0;
  private height = 0;
  private reducedMotion = false;
  private vibeHost: VibeHost;

  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    host.appendChild(this.canvas);

    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const self = this;
    this.vibeHost = {
      canvas: this.canvas,
      container: this.host,
      get width() {
        return self.width;
      },
      get height() {
        return self.height;
      },
      onResize(cb) {
        self.resizeListeners.add(cb);
        return () => {
          self.resizeListeners.delete(cb);
        };
      },
    };

    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(host);
    window.addEventListener("resize", this.handleResize);
    this.handleResize();
  }

  private handleResize = () => {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // Vibes own their renderer and manage the canvas backing-store size
    // (butterchurn does so via `pixelRatio`, three.js via setSize+setPixelRatio).
    // Stage just announces the new CSS-pixel size.
    this.resizeListeners.forEach((cb) => cb(w, h));
  };

  async setVibe(vibe: Vibe): Promise<void> {
    // butterchurn takes webgl1, our custom vibes take webgl2 — and a canvas's
    // context type is locked once chosen. Swap by replacing the canvas itself.
    if (this.vibe) {
      try {
        this.vibe.unmount();
      } catch (e) {
        console.error("vibe unmount failed", e);
      }
      this.vibe = null;
      this.canvas.remove();
      this.canvas = document.createElement("canvas");
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      this.host.appendChild(this.canvas);
      // Rebuild vibeHost.canvas pointer; container stays the same.
      (this.vibeHost as { canvas: HTMLCanvasElement }).canvas = this.canvas;
    }
    // Make sure the canvas is visible at the start of each mount; DOM-only
    // vibes can hide it themselves.
    this.canvas.style.display = "block";
    await vibe.mount(this.vibeHost);
    this.vibe = vibe;
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

      if (this.vibe) {
        try {
          this.vibe.update(frame, dtMs);
        } catch (e) {
          console.error("vibe update error", e);
        }
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
    if (this.vibe) {
      try {
        this.vibe.unmount();
      } catch {}
      this.vibe = null;
    }
    this.resizeObs.disconnect();
    window.removeEventListener("resize", this.handleResize);
    this.resizeListeners.clear();
    if (this.canvas.parentElement === this.host) {
      this.host.removeChild(this.canvas);
    }
  }
}
