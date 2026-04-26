import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { FontLoader, type Font } from "three/examples/jsm/loaders/FontLoader.js";
import type { AudioFrame, LyricLine } from "../types";

// Spatial 3D lyric renderer — solid extruded text that reacts to the music.
//
// Each lyric word is built as a real `TextGeometry` mesh with depth + bevels,
// lit by a small light rig (key + fill + accent). As the song plays, the
// renderer "flies" through the timeline: future words live deep in the
// distance and approach, peak at the camera at the midpoint of their sung
// window, then whoosh past.
//
// On every audio frame:
//   - Beat → springy scale punch + emissive glow flash + Y-rotation kick
//   - Bass → Z-axis depth pulse (extrusion stretches), accent light pulses
//   - Mid/treble → subtle warm/cool tint shifts (kept low-saturation)
//   - Level → bobbing breath
//
// Compared to the standalone Fly-through *vibe* this stays:
//   - White-leaning palette (no rainbow cycling)
//   - More centered (tight lateral spread)
//   - Geometry-real instead of SDF, so it feels like solid 3D objects.

const FAR_Z = -36;
const NEAR_Z = 4;
const FLY_SPEED_UPS = 0.024;
const SPRING_STIFFNESS = 360;
const SPRING_DAMPING = 16;
const PUNCH_STIFFNESS = 120;
const PUNCH_DAMPING = 10;
/** Half-distance between consecutive words within a line (world units). */
const LATERAL_SLOT = 1.4;

const FONT_URL = "/fonts/helvetiker_bold.typeface.json";

let fontPromise: Promise<Font> | null = null;
function loadFont(): Promise<Font> {
  if (!fontPromise) {
    fontPromise = fetch(FONT_URL)
      .then((r) => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((j) => new FontLoader().parse(j as any));
  }
  return fontPromise;
}

interface WordEntry {
  mesh: THREE.Mesh;
  geometry: TextGeometry;
  material: THREE.MeshPhysicalMaterial;
  startMs: number;
  endMs: number;
  lineSlot: number;
  // Time-window activation spring (driven by playhead).
  active: number;
  scaleVel: number;
  // Beat-driven punch spring (driven by audio.beat).
  punch: number;
  punchVel: number;
  // Emissive flash on beat — decays linearly.
  emissive: number;
  // Spring for fly-in: the word starts at spawnZ offset and lerps to its real Z.
  spawnZOffset: number;
  spawnAge: number;
  jitterSeed: number;
  // Y-axis rotation that gets a kick on beat and decays each frame.
  rotYImpulse: number;
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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

export class Lyric3DRenderer {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private resizeObs: ResizeObserver;

  // Light rig.
  private ambient: THREE.AmbientLight;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private accent: THREE.PointLight;

  // Words.
  private font: Font | null = null;
  private words: WordEntry[] = [];
  private allTimings: AllTiming[] = [];
  private activeStart = 0;
  private activeEnd = -1;
  private pendingSpawn: AllTiming[] = []; // queued spawns waiting for font load

  // State.
  private elapsed = 0;
  private positionMs = 0;
  private visible = true;
  private currentLinesKey = "";
  /** Last-frame audio.beat; used to detect rising-edge "beat just fired". */
  private prevBeat = 0;
  /** Cached colour objects we mutate in-place to avoid GC churn per frame. */
  private tmpColor = new THREE.Color();
  private warmColor = new THREE.Color(0xfff0d0);
  private coolColor = new THREE.Color(0xb6d6ff);
  private baseColor = new THREE.Color(0xf2f5ff);
  private emissiveBase = new THREE.Color(0x223355);
  private emissiveHot = new THREE.Color(0x88aaff);

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

    // Lights — three-light rig that catches bevels nicely.
    this.ambient = new THREE.AmbientLight(0x9090b0, 0.55);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.keyLight.position.set(3, 4, 5);
    this.fillLight = new THREE.DirectionalLight(0x99aaff, 0.4);
    this.fillLight.position.set(-3, -1, 3);
    this.accent = new THREE.PointLight(0x88aaff, 0.8, 25);
    this.accent.position.set(0, 0, 5);
    this.scene.add(this.ambient, this.keyLight, this.fillLight, this.accent);

    // Async font load — words spawned before the font lands queue up.
    void loadFont().then((f) => {
      this.font = f;
      for (const t of this.pendingSpawn) this.words.push(this.spawnWordWithFont(t));
      this.pendingSpawn = [];
    }, (e) => {
      console.error("[lyric3d] font load failed", e);
    });

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
    for (const w of this.words) this.disposeWord(w);
    this.words = [];
    this.pendingSpawn = [];
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

  update(positionMs: number, dtMs: number, audio: AudioFrame | null): void {
    if (!this.visible) return;
    this.positionMs = positionMs;
    const dt = Math.max(0.001, Math.min(0.1, dtMs / 1000));
    this.elapsed += dt;

    // Detect "beat just fired" via rising edge on audio.beat.
    const beat = audio?.beat ?? 0;
    const beatRose = this.prevBeat < 0.5 && beat > 0.7;
    this.prevBeat = beat;

    // Drive the accent light from audio level + beat.
    const lvl = audio?.level ?? 0;
    this.accent.intensity = 0.6 + 0.7 * lvl + 0.6 * beat;
    // Tiny treble-driven hue lift on key light — almost unnoticeable, just alive.
    const treble = audio?.treble ?? 0;
    this.keyLight.color.setHSL(0.6 + treble * 0.05, 0.05, 0.85);

    this.updateWindow();
    this.tickWords(dt, audio, beatRose);
    this.renderer.render(this.scene, this.camera);
  }

  unmount(): void {
    this.resizeObs.disconnect();
    for (const w of this.words) this.disposeWord(w);
    this.words = [];
    this.scene.remove(this.ambient, this.keyLight, this.fillLight, this.accent);
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- internals ----

  private zForTime(startMs: number): number {
    const tToDueMs = startMs - this.positionMs;
    return -tToDueMs * FLY_SPEED_UPS;
  }

  private spawnWord(t: AllTiming): WordEntry | null {
    if (!this.font) {
      // Queue until the font lands; updateWindow will wait until words appear
      // on screen for real, but to avoid a stall we mirror the spawn intent.
      this.pendingSpawn.push(t);
      return null;
    }
    return this.spawnWordWithFont(t);
  }

  private spawnWordWithFont(t: AllTiming): WordEntry {
    const geometry = new TextGeometry(t.text, {
      font: this.font!,
      size: 1.6,
      // three.js's TextGeometry uses `depth` in r163+ (was `height` previously).
      // Cast through `any` so we cover both APIs without TS friction.
      height: 0.32,
      depth: 0.32,
      curveSegments: 5,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.025,
      bevelSegments: 3,
    } as unknown as ConstructorParameters<typeof TextGeometry>[1]);
    geometry.computeBoundingBox();
    geometry.center();

    const material = new THREE.MeshPhysicalMaterial({
      color: this.baseColor.clone(),
      metalness: 0.45,
      roughness: 0.42,
      emissive: this.emissiveBase.clone(),
      emissiveIntensity: 0,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    const slotOffset = (t.slot - (t.totalSlots - 1) / 2) * LATERAL_SLOT;
    const spawnZOffset = -8 + Math.random() * 6; // 6-14 units behind their target

    return {
      mesh,
      geometry,
      material,
      startMs: t.startMs,
      endMs: t.endMs,
      lineSlot: slotOffset,
      active: 0,
      scaleVel: 0,
      punch: 0,
      punchVel: 0,
      emissive: 0,
      spawnZOffset,
      spawnAge: 0,
      jitterSeed: Math.random() * 6.28,
      rotYImpulse: 0,
    };
  }

  private disposeWord(w: WordEntry): void {
    this.scene.remove(w.mesh);
    w.geometry.dispose();
    w.material.dispose();
  }

  private updateWindow(): void {
    // Despawn well-passed words.
    while (this.words.length > 0) {
      const head = this.words[0];
      const z = this.zForTime(head.startMs);
      if (z > NEAR_Z + 4) {
        this.disposeWord(head);
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
        this.activeEnd++;
        continue;
      }
      const word = this.spawnWord(next);
      if (word) this.words.push(word);
      this.activeEnd++;
    }
  }

  private tickWords(dt: number, audio: AudioFrame | null, beatRose: boolean): void {
    const bass = audio?.bass ?? 0;
    const mid = audio?.mid ?? 0;
    const treble = audio?.treble ?? 0;
    const level = audio?.level ?? 0;
    const beat = audio?.beat ?? 0;

    for (const w of this.words) {
      const targetZ = this.zForTime(w.startMs);
      // Fly-in: blend from spawn offset toward the time-driven Z over ~600ms.
      w.spawnAge += dt * 1000;
      const flyInBlend = smoothstep(0, 600, w.spawnAge);
      const z = THREE.MathUtils.lerp(targetZ + w.spawnZOffset, targetZ, flyInBlend);

      // Tiny jitter so the line breathes.
      const jx = Math.sin(this.elapsed * 0.6 + w.jitterSeed) * 0.05;
      const baseY = Math.cos(this.elapsed * 0.8 + w.jitterSeed * 1.3) * 0.04;
      const breath = Math.sin(this.elapsed * 1.4 + w.jitterSeed * 0.5) * 0.04;
      const y = baseY + breath + level * 0.06;
      w.mesh.position.set(w.lineSlot + jx, y, z);

      // ---- Activation spring (time-window driven) ----
      const inside = this.positionMs >= w.startMs - 80 && this.positionMs <= w.endMs + 200;
      const target = inside ? 1.0 : 0.0;
      const accel = (target - w.active) * SPRING_STIFFNESS - w.scaleVel * SPRING_DAMPING;
      w.scaleVel += accel * dt;
      w.active += w.scaleVel * dt;
      if (w.active > 1.5) { w.active = 1.5; w.scaleVel *= -0.3; }
      if (w.active < -0.05) { w.active = -0.05; w.scaleVel *= -0.3; }

      // ---- Punch spring (beat driven) ----
      // On a fresh beat, kick the velocity of every visible word — the active
      // ones bounce harder.
      if (beatRose) {
        const kick = (inside ? 6 : 1.5) + bass * 4;
        w.punchVel += kick;
        // Emissive flash, slightly stronger on currently-sung words.
        w.emissive = Math.max(w.emissive, (inside ? 0.85 : 0.55) + bass * 0.4);
        // A small Y rotation impulse on active words for liveliness.
        if (inside) w.rotYImpulse += 0.12;
      }
      const pAccel = (0 - w.punch) * PUNCH_STIFFNESS - w.punchVel * PUNCH_DAMPING;
      w.punchVel += pAccel * dt;
      w.punch += w.punchVel * dt;
      if (w.punch > 2.0) { w.punch = 2.0; w.punchVel *= -0.3; }
      if (w.punch < -0.2) { w.punch = -0.2; w.punchVel *= -0.3; }

      // Emissive decays every frame.
      w.emissive = Math.max(0, w.emissive - dt * 2.5);
      // Y rotation impulse decays.
      w.rotYImpulse *= Math.pow(0.92, dt * 60);

      // ---- Apply to mesh ----
      const baseScale = 0.7 + 0.55 * Math.max(0, w.active);
      const scale = baseScale * (1 + 0.18 * w.punch + 0.06 * bass);
      w.mesh.scale.set(scale, scale, scale * (1 + 0.45 * bass + 0.3 * w.punch));

      // Rotation: subtle Z roll always; Y carries the beat impulse on active words.
      const rotZ = Math.sin(this.elapsed * 0.7 + w.jitterSeed) * 0.02;
      w.mesh.rotation.set(0, w.rotYImpulse, rotZ);

      // Color: white-leaning, with tiny warm/cool tints from mid/treble.
      this.tmpColor.copy(this.baseColor)
        .lerp(this.warmColor, mid * 0.25)
        .lerp(this.coolColor, treble * 0.18);
      // Activation slightly brightens the color on top of that.
      this.tmpColor.multiplyScalar(0.85 + 0.25 * w.active);
      w.material.color.copy(this.tmpColor);

      // Emissive: blue → bright blue on beat-flash; intensity from emissive spring.
      this.tmpColor.copy(this.emissiveBase).lerp(this.emissiveHot, Math.min(1, w.emissive));
      w.material.emissive.copy(this.tmpColor);
      w.material.emissiveIntensity = w.emissive;

      // Depth-based opacity fade. Words approach from very negative Z, peak
      // around z=0, continue closer to camera (positive z up to ~4 = camera
      // position), then despawn. Keep them readable through that whole arc.
      let opacity: number;
      if (z < 0) {
        // Fade in from the distance.
        opacity = THREE.MathUtils.clamp(1 + z / -FAR_Z, 0, 1);
        opacity = 0.25 + 0.75 * opacity;
      } else if (z < 3) {
        opacity = 1;
      } else {
        // Last unit before the camera position (z=4): fade out so we don't
        // get the camera-engulfing-word effect.
        opacity = Math.max(0, 1 - (z - 3) / 1);
      }
      // Fly-in also drives an opacity ramp so words don't pop in suddenly.
      opacity *= 0.15 + 0.85 * flyInBlend;
      w.material.opacity = opacity;
      w.material.transparent = opacity < 0.999;
    }

    // Suppress unused-var warnings while keeping the spectrum vars referenced.
    void beat;
  }
}
