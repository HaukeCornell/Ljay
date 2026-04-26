import * as THREE from "three";
import { Text } from "troika-three-text";
import type { LyricLine } from "../types";

// Spatial 3D lyric renderer — usable on top of any vibe.
//
// Mounts a transparent WebGL canvas inside the lyric layer, runs a three.js
// scene where each lyric word is a troika SDF Text mesh placed in space by
// time. As the song plays, the camera "flies forward": future words live
// deep in the distance and approach, peak at the camera at the midpoint of
// their sung window, then whoosh past.
//
// Compared to the standalone Fly-through vibe this is:
//   - Less colorful (white text + soft blue glow, no palette cycling)
//   - More centered (tight lateral spread so the line sits visually compact)
//   - No starfield, no grid (those belong to whatever vibe is below)

const FAR_Z = -36;
const NEAR_Z = 4;
const FLY_SPEED_UPS = 0.024;
const SPRING_STIFFNESS = 360;
const SPRING_DAMPING = 16;
/** Half-distance between consecutive words within a line (world units). */
const LATERAL_SLOT = 1.4;

interface WordEntry {
  text: any;
  startMs: number;
  endMs: number;
  lineSlot: number;
  active: number;
  scaleVel: number;
  jitterSeed: number;
}

interface AllTiming {
  text: string;
  startMs: number;
  endMs: number;
  lineIdx: number;
  slot: number;
  totalSlots: number;
}

function inferWordTimings(line: LyricLine): { text: string; startMs: number; endMs: number }[] {
  const tokens = line.text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const lineEnd = line.endMs ?? line.startMs + Math.max(1500, tokens.length * 220);
  const lineDur = Math.max(200, lineEnd - line.startMs);
  if (line.words && line.words.length === tokens.length) {
    const out: { text: string; startMs: number; endMs: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const startMs = line.words[i].startMs;
      const endMs = i + 1 < line.words.length ? line.words[i + 1].startMs : lineEnd;
      out.push({ text: tokens[i], startMs, endMs });
    }
    return out;
  }
  const totalChars = tokens.reduce((s, t) => s + Math.max(1, t.length), 0);
  let cursor = line.startMs;
  const out: { text: string; startMs: number; endMs: number }[] = [];
  for (const t of tokens) {
    const share = Math.max(1, t.length) / totalChars;
    const slice = lineDur * share;
    out.push({ text: t, startMs: cursor, endMs: cursor + slice });
    cursor += slice;
  }
  return out;
}

export class Lyric3DRenderer {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private resizeObs: ResizeObserver;
  private words: WordEntry[] = [];
  private allTimings: AllTiming[] = [];
  private activeStart = 0;
  private activeEnd = -1;
  private elapsed = 0;
  private positionMs = 0;
  private visible = true;
  private currentLinesKey = "";

  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    host.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 0, 4);
    this.camera.lookAt(0, 0, 0);

    this.handleResize();
    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(host);
  }

  private handleResize = () => {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.canvas.style.display = v ? "" : "none";
  }

  setLines(lines: LyricLine[] | null): void {
    const key = lines ? `${lines.length}:${lines[0]?.startMs ?? 0}:${lines[0]?.text ?? ""}` : "none";
    if (key === this.currentLinesKey) return;
    this.currentLinesKey = key;
    // Tear down all current word meshes.
    for (const w of this.words) {
      this.scene.remove(w.text);
      w.text.dispose?.();
    }
    this.words = [];
    this.allTimings = [];
    this.activeStart = 0;
    this.activeEnd = -1;
    if (!lines) return;
    for (let i = 0; i < lines.length; i++) {
      const wt = inferWordTimings(lines[i]);
      const total = wt.length;
      for (let j = 0; j < wt.length; j++) {
        this.allTimings.push({
          text: wt[j].text,
          startMs: wt[j].startMs,
          endMs: wt[j].endMs,
          lineIdx: i,
          slot: j,
          totalSlots: total,
        });
      }
    }
  }

  update(positionMs: number, dtMs: number): void {
    if (!this.visible) return;
    this.positionMs = positionMs;
    const dt = dtMs / 1000;
    this.elapsed += dt;
    this.updateWindow();
    this.tickWords(dt);
    this.renderer.render(this.scene, this.camera);
  }

  unmount(): void {
    this.resizeObs.disconnect();
    for (const w of this.words) {
      this.scene.remove(w.text);
      w.text.dispose?.();
    }
    this.words = [];
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- internals ----

  private zForTime(startMs: number): number {
    const tToDueMs = startMs - this.positionMs;
    return -tToDueMs * FLY_SPEED_UPS;
  }

  private spawnWord(t: AllTiming): WordEntry {
    const text = new Text();
    text.text = t.text;
    text.fontSize = 1.6;                     // big enough to read at center, small enough that long lines fit
    text.anchorX = "center";
    text.anchorY = "middle";
    text.outlineWidth = 0.06;                // strong outline for legibility on busy backgrounds
    text.outlineColor = 0x000000;
    text.outlineBlur = 0.05;
    text.outlineOpacity = 0.95;
    text.color = 0xffffff;
    text.fillOpacity = 1.0;
    text.frustumCulled = false;
    this.scene.add(text);
    text.sync();

    const slotOffset = (t.slot - (t.totalSlots - 1) / 2) * LATERAL_SLOT;

    return {
      text,
      startMs: t.startMs,
      endMs: t.endMs,
      lineSlot: slotOffset,
      active: 0,
      scaleVel: 0,
      jitterSeed: Math.random() * 6.28,
    };
  }

  private updateWindow(): void {
    // Despawn well-passed words.
    while (this.words.length > 0) {
      const head = this.words[0];
      const z = this.zForTime(head.startMs);
      if (z > NEAR_Z + 4) {
        this.scene.remove(head.text);
        head.text.dispose?.();
        this.words.shift();
        this.activeStart++;
      } else break;
    }
    // Spawn upcoming words that fall in the visible Z window.
    while (this.activeEnd + 1 < this.allTimings.length) {
      const next = this.allTimings[this.activeEnd + 1];
      const z = this.zForTime(next.startMs);
      if (z < FAR_Z) break;
      if (z > NEAR_Z + 4) {
        // Already past — skip (e.g. user scrubbed forward).
        this.activeEnd++;
        continue;
      }
      this.words.push(this.spawnWord(next));
      this.activeEnd++;
    }
  }

  private tickWords(dt: number): void {
    for (const w of this.words) {
      const z = this.zForTime(w.startMs);
      // Tiny jitter so the line breathes — kept very small to stay readable.
      const jx = Math.sin(this.elapsed * 0.6 + w.jitterSeed) * 0.05;
      const jy = Math.cos(this.elapsed * 0.8 + w.jitterSeed * 1.3) * 0.04;
      w.text.position.set(w.lineSlot + jx, jy, z);

      // Spring-driven activation: 1 while word is being sung, 0 outside.
      const inside = this.positionMs >= w.startMs - 80 && this.positionMs <= w.endMs + 200;
      const target = inside ? 1.0 : 0.0;
      const accel = (target - w.active) * SPRING_STIFFNESS - w.scaleVel * SPRING_DAMPING;
      w.scaleVel += accel * dt;
      w.active += w.scaleVel * dt;
      if (w.active > 1.5) { w.active = 1.5; w.scaleVel *= -0.3; }
      if (w.active < -0.05) { w.active = -0.05; w.scaleVel *= -0.3; }

      const scale = 0.7 + 0.55 * Math.max(0, w.active);
      w.text.scale.setScalar(scale);

      // Keep rotations tiny — this is meant to be readable, not chaotic.
      w.text.rotation.set(0, 0, Math.sin(this.elapsed * 0.7 + w.jitterSeed) * 0.02);

      // Color: white with a soft blue tint that warms slightly on activation.
      // No palette cycle — this is the "less colorful" lyric mode.
      const r = 0.92 + 0.08 * w.active;
      const g = 0.94 + 0.06 * w.active;
      const b = 1.0;
      w.text.color = new THREE.Color(r, g, b).getHex();

      // Depth-based opacity: faint while in the distance, full near camera,
      // fade quickly after passing.
      let opacity: number;
      if (z < 0) {
        // Ahead of camera — fade in from the distance.
        opacity = THREE.MathUtils.clamp(1 + z / -FAR_Z, 0, 1);
        opacity = 0.25 + 0.75 * opacity;
      } else if (z < 1.5) {
        opacity = 1;
      } else {
        opacity = Math.max(0, 1 - (z - 1.5) / 1.8);
      }
      w.text.fillOpacity = opacity;
      // Outline glow brightens slightly when the word is active.
      w.text.outlineColor = w.active > 0.3 ? 0x0a1430 : 0x000000;
      w.text.outlineOpacity = 0.85 + 0.15 * w.active;
    }
  }
}
