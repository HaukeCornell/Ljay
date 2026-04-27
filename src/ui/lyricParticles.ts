import * as THREE from "three";
import type { AudioFrame, LinkState, LyricLine } from "../types";

// Particle-text lyric mode.
//
// Renders the currently-sung word as a cloud of GPU points whose home
// positions are sampled from a rasterized version of the word.
// Particles spring into formation, breathe on bass, get a radial impulse
// on each beat (Link if available, energy-onset otherwise), and smoothly
// transition to the next word.
//
// PURE LYRIC LAYER — transparent canvas, no background field, no FFT bars.
// Pair with any vibe to compose: e.g. halftone vibe + particles = particles
// glowing through a printed-page backdrop. Pair with the `flythrough` vibe
// for the old "particles drifting through warp space" look.

const PARTICLE_COUNT = 6000;
/** World-space half-width of the rendered word at default zoom. */
const WORD_HALF_WIDTH = 6;
/** Velocity damping rate (per second; final factor = exp(-rate * dt)). */
const VEL_DAMPING_RATE = 8;
/** Spring stiffness for particles approaching their home (1/sec^2). */
const SPRING_K = 60;
/** Bass-to-jitter conversion (random per-frame velocity bump magnitude). */
const BASS_JITTER = 4.0;
/** Beat-impulse magnitude (instantaneous velocity kick, world-units/sec). */
const BEAT_KICK = 4.5;
/** Bar (downbeat) impulse multiplier. */
const DOWNBEAT_MULT = 1.8;
/** Word-change blast — outward kick when transitioning words. */
const WORD_CHANGE_BLAST = 3.0;

const PARTICLE_VERT = /* glsl */ `
attribute float aSeed;
attribute float aColorMix;
varying float vSeed;
varying float vColorMix;
uniform float uTime;
uniform float uPointSize;
uniform float uViewportH;

void main() {
  vSeed = aSeed;
  vColorMix = aColorMix;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPointSize * (uViewportH / 800.0);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
varying float vSeed;
varying float vColorMix;
uniform float uTime;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uGlow;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 28.0);
  float halo = exp(-r2 * 8.0) * 0.55;
  float alpha = core + halo;
  vec3 col = mix(uColorA, uColorB, vColorMix);
  col *= 0.85 + 0.15 * sin(uTime * (3.0 + vSeed * 5.0) + vSeed * 6.28);
  col *= 1.0 + uGlow * 1.2;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

// ---------- helpers ----------

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

const SAMPLE_CANVAS = document.createElement("canvas");
SAMPLE_CANVAS.width = 1600;
SAMPLE_CANVAS.height = 380;
const SAMPLE_CTX = SAMPLE_CANVAS.getContext("2d", { willReadFrequently: true })!;

function sampleWordHomes(text: string): Float32Array {
  const out = new Float32Array(PARTICLE_COUNT * 2);
  const ctx = SAMPLE_CTX;
  const w = SAMPLE_CANVAS.width;
  const h = SAMPLE_CANVAS.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  let fontSize = 220;
  ctx.font = `900 ${fontSize}px "Helvetica Neue", "Inter", Arial, sans-serif`;
  let textWidth = ctx.measureText(text).width;
  const target = w * 0.86;
  if (textWidth > target) {
    fontSize = Math.max(60, Math.floor((fontSize * target) / textWidth));
    ctx.font = `900 ${fontSize}px "Helvetica Neue", "Inter", Arial, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);

  const data = ctx.getImageData(0, 0, w, h).data;
  const samples: number[] = [];
  const step = 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i] > 128) samples.push(x, y);
    }
  }
  if (samples.length === 0) {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      out[i * 2 + 0] = (Math.random() - 0.5) * 2;
      out[i * 2 + 1] = (Math.random() - 0.5) * 0.6;
    }
    return out;
  }
  const sx = (2 * WORD_HALF_WIDTH) / w;
  const sy = sx;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const k = (Math.random() * (samples.length / 2)) | 0;
    const x = samples[k * 2];
    const y = samples[k * 2 + 1];
    out[i * 2 + 0] = (x - w / 2 + (Math.random() - 0.5) * step) * sx;
    out[i * 2 + 1] = -(y - h / 2 + (Math.random() - 0.5) * step) * sy;
  }
  return out;
}

// ---------- renderer ----------

interface ParticleUniforms {
  uTime: { value: number };
  uPointSize: { value: number };
  uViewportH: { value: number };
  uColorA: { value: THREE.Color };
  uColorB: { value: THREE.Color };
  uGlow: { value: number };
  [k: string]: THREE.IUniform;
}

export class LyricParticlesRenderer {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private resizeObs: ResizeObserver;

  private points: THREE.Points;
  private pGeo: THREE.BufferGeometry;
  private pPos: Float32Array;
  private pVel: Float32Array;
  private pHomeCur: Float32Array;
  private pHomeNext: Float32Array | null = null;
  private pTransitionAge = 1.0;
  private pSeeds: Float32Array;
  private pColorMix: Float32Array;
  private pU: ParticleUniforms;
  private cohesion = 0.85;

  private allTimings: { text: string; startMs: number; endMs: number }[] = [];
  private activeTimingIdx = -1;
  private currentWord: string | null = null;
  private positionMs = 0;
  private elapsed = 0;
  private visible = true;
  private currentLinesKey = "";
  private prevLinkBeatInt = -1;
  private prevAudioBeat = 0;
  private glow = 0;
  /** Panel-driven reactivity multiplier (1 = vibe default). */
  private reactivity = 1;
  /** Hold mode: keep particles locked on the most recent word during gaps. */
  private hold = false;

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
      canvas: this.canvas, alpha: true, antialias: false, premultipliedAlpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, -10, 10);

    this.pGeo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(PARTICLE_COUNT * 3);
    this.pVel = new Float32Array(PARTICLE_COUNT * 2);
    this.pHomeCur = new Float32Array(PARTICLE_COUNT * 2);
    this.pSeeds = new Float32Array(PARTICLE_COUNT);
    this.pColorMix = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.pPos[i * 3 + 0] = (Math.random() - 0.5) * 16;
      this.pPos[i * 3 + 1] = (Math.random() - 0.5) * 9;
      this.pPos[i * 3 + 2] = 0;
      this.pVel[i * 2 + 0] = (Math.random() - 0.5) * 0.5;
      this.pVel[i * 2 + 1] = (Math.random() - 0.5) * 0.5;
      this.pHomeCur[i * 2 + 0] = this.pPos[i * 3 + 0];
      this.pHomeCur[i * 2 + 1] = this.pPos[i * 3 + 1];
      this.pSeeds[i] = Math.random();
      this.pColorMix[i] = Math.random();
    }
    this.pGeo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute("aSeed", new THREE.BufferAttribute(this.pSeeds, 1));
    this.pGeo.setAttribute("aColorMix", new THREE.BufferAttribute(this.pColorMix, 1));
    this.pU = {
      uTime: { value: 0 },
      uPointSize: { value: 7.0 },
      uViewportH: { value: 800 },
      uColorA: { value: new THREE.Color(0xffe4b8) },
      uColorB: { value: new THREE.Color(0xc8e0ff) },
      uGlow: { value: 0 },
    };
    const pMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      uniforms: this.pU as unknown as { [k: string]: THREE.IUniform },
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.pGeo, pMat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.handleResize();
    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(host);
  }

  private handleResize = () => {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.pU.uViewportH.value = h;
    const aspect = w / h;
    const halfH = 4.5;
    const halfW = halfH * aspect;
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.top = halfH; this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  };

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.canvas.style.display = v ? "" : "none";
  }

  setHold(v: boolean): void {
    this.hold = v;
  }

  /** Apply panel-driven overrides. `color`/`accent` recolor the particle
   *  cloud; `reactivity` scales the bass jitter and beat kick. */
  setColors(o: { color?: string; accent?: string; reactivity?: number }): void {
    if (typeof o.color === "string") this.pU.uColorA.value.set(o.color);
    if (typeof o.accent === "string") this.pU.uColorB.value.set(o.accent);
    if (typeof o.reactivity === "number" && Number.isFinite(o.reactivity)) {
      this.reactivity = Math.max(0, o.reactivity);
    }
  }

  setLines(lines: LyricLine[] | null): void {
    const key = lines ? `${lines.length}:${lines[0]?.startMs ?? 0}:${lines[0]?.text ?? ""}` : "none";
    if (key === this.currentLinesKey) return;
    this.currentLinesKey = key;
    this.allTimings = [];
    this.activeTimingIdx = -1;
    this.currentWord = null;
    if (!lines) return;
    for (const line of lines) {
      const wt = inferWordTimings(line);
      for (const w of wt) this.allTimings.push(w);
    }
  }

  update(positionMs: number, dtMs: number, audio: AudioFrame | null, link: LinkState | null): void {
    if (!this.visible) return;
    this.positionMs = positionMs;
    const dt = Math.max(0.001, Math.min(0.1, dtMs / 1000));
    this.elapsed += dt;

    const newIdx = this.findActiveTimingIdx(positionMs);
    if (newIdx !== this.activeTimingIdx) {
      this.activeTimingIdx = newIdx;
      const word = newIdx >= 0 ? this.allTimings[newIdx].text : null;
      if (word !== this.currentWord && word !== null) {
        this.startWordTransition(word);
      }
    }

    let beatRose = false;
    let downbeat = false;
    if (link && link.bpm > 0 && link.playing) {
      const beatsPerMs = link.bpm / 60_000;
      const elapsedSinceAnchor = performance.now() - link.anchorMs;
      const beatNow = link.beat + elapsedSinceAnchor * beatsPerMs;
      const beatInt = Math.floor(beatNow);
      if (beatInt !== this.prevLinkBeatInt) {
        if (this.prevLinkBeatInt !== -1) {
          beatRose = true;
          downbeat = beatInt % link.quantum === 0;
        }
        this.prevLinkBeatInt = beatInt;
      }
    } else {
      const ab = audio?.beat ?? 0;
      beatRose = this.prevAudioBeat < 0.5 && ab > 0.7;
      this.prevAudioBeat = ab;
    }

    this.tickParticles(dt, audio, beatRose, downbeat);

    this.glow = Math.max(0, this.glow - dt * 2);
    if (beatRose) this.glow = Math.min(1.5, this.glow + (downbeat ? 0.9 : 0.6));
    this.pU.uGlow.value = this.glow;
    this.pU.uTime.value = this.elapsed;

    this.renderer.render(this.scene, this.camera);
  }

  unmount(): void {
    this.resizeObs.disconnect();
    this.scene.remove(this.points);
    this.pGeo.dispose();
    (this.points.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- internals ----

  private findActiveTimingIdx(positionMs: number): number {
    let lo = 0, hi = this.allTimings.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.allTimings[mid].startMs <= positionMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans < 0) return -1;
    const w = this.allTimings[ans];
    if (positionMs > w.endMs + 1500 && ans + 1 < this.allTimings.length) {
      const nextStart = this.allTimings[ans + 1].startMs;
      if (positionMs < nextStart) return -1;
    }
    return ans;
  }

  private startWordTransition(newWord: string): void {
    this.pHomeNext = sampleWordHomes(newWord);
    this.pTransitionAge = 0;
    this.currentWord = newWord;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = this.pPos[i * 3 + 0];
      const y = this.pPos[i * 3 + 1];
      const r = Math.max(0.0001, Math.hypot(x, y));
      const m = (Math.random() * 0.6 + 0.4) * WORD_CHANGE_BLAST;
      this.pVel[i * 2 + 0] += (x / r) * m;
      this.pVel[i * 2 + 1] += (y / r) * m;
    }
  }

  private tickParticles(dt: number, audio: AudioFrame | null, beatRose: boolean, downbeat: boolean): void {
    const damping = Math.exp(-VEL_DAMPING_RATE * dt);
    const k = SPRING_K;
    const bass = audio?.bass ?? 0;
    const level = audio?.level ?? 0;

    // Hold mode: when no word is currently active but we have one onscreen,
    // keep the particles locked on it instead of dispersing.
    const hasFormation = this.currentWord !== null;
    const targetCohesion = (this.activeTimingIdx >= 0 || (this.hold && hasFormation)) ? 1.0 : 0.55;
    this.cohesion += (targetCohesion - this.cohesion) * Math.min(1, dt * 4);

    if (this.pHomeNext) {
      this.pTransitionAge = Math.min(1, this.pTransitionAge + dt * (1000 / 520));
      if (this.pTransitionAge >= 1) {
        this.pHomeCur = this.pHomeNext;
        this.pHomeNext = null;
      }
    }

    const r = this.reactivity;
    const kickMag = beatRose ? BEAT_KICK * (downbeat ? DOWNBEAT_MULT : 1) * (0.5 + bass) * r : 0;
    const jitter = bass * BASS_JITTER * dt * r;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const hcx = this.pHomeCur[i * 2 + 0];
      const hcy = this.pHomeCur[i * 2 + 1];
      let tx = hcx, ty = hcy;
      if (this.pHomeNext) {
        const t = this.pTransitionAge;
        const eased = t * t * (3 - 2 * t);
        tx = hcx * (1 - eased) + this.pHomeNext[i * 2 + 0] * eased;
        ty = hcy * (1 - eased) + this.pHomeNext[i * 2 + 1] * eased;
      }

      let x = this.pPos[i * 3 + 0];
      let y = this.pPos[i * 3 + 1];
      let vx = this.pVel[i * 2 + 0];
      let vy = this.pVel[i * 2 + 1];

      const dx = tx - x;
      const dy = ty - y;
      vx += dx * k * this.cohesion * dt;
      vy += dy * k * this.cohesion * dt;

      if (jitter > 0) {
        vx += (Math.random() - 0.5) * jitter;
        vy += (Math.random() - 0.5) * jitter;
      }

      if (kickMag > 0) {
        const r = Math.max(1e-3, Math.hypot(x, y));
        const m = kickMag * (0.5 + Math.random() * 0.5);
        vx += (x / r) * m;
        vy += (y / r) * m;
      }

      if (level > 0.05) {
        const swirlAngle = this.elapsed * 0.4 + this.pSeeds[i] * 6.28;
        const swirl = level * 1.5;
        vx += Math.cos(swirlAngle) * swirl * dt;
        vy += Math.sin(swirlAngle) * swirl * dt;
      }

      vx *= damping;
      vy *= damping;
      x += vx * dt;
      y += vy * dt;

      this.pPos[i * 3 + 0] = x;
      this.pPos[i * 3 + 1] = y;
      this.pVel[i * 2 + 0] = vx;
      this.pVel[i * 2 + 1] = vy;
    }
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
