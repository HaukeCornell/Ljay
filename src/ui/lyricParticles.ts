import * as THREE from "three";
import type { AudioFrame, LinkState, LyricLine } from "../types";

// Particle-text + spectral field lyric mode.
//
//   1. Background: Perlin-noise field, color-tinted by FFT bands so the room
//      glows warm on bass and cool on treble. Subtle, never competes with the
//      foreground.
//   2. Spectrogram bars: a log-spaced bar at the bottom 1/8 of the canvas
//      reading directly from `audio.fft`. Quiet musical "EQ display".
//   3. Particle word: the currently-sung word is rendered to an offscreen 2D
//      canvas; opaque pixels are sampled as ~PARTICLE_COUNT "home" positions.
//      Particles spring to formation, breathe on bass, get a radial impulse
//      on each beat (Link if available, energy-onset otherwise), and smoothly
//      transition to the next word.
//
// Updated via `update(positionMs, dtMs, audio, link)`. Owns its own canvas,
// scene and animation loop. The vibe canvas behind it keeps rendering — this
// layer is transparent (`alpha: true`).

const PARTICLE_COUNT = 6000;
/** World-space half-width of the rendered word at default zoom. */
const WORD_HALF_WIDTH = 6;
/** Spectrum log-band count for the spectrogram bars. */
const BAND_COUNT = 64;
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

// ---------- shaders ----------

const FULL_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const FIELD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p) {
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { f += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return f;
}

void main() {
  vec2 c = (vUv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
  float r = length(c);

  // Two layers of noise drifting in opposite directions create a slow swirl.
  float n1 = fbm(c * 1.4 + vec2(uTime * 0.06, uTime * 0.04));
  float n2 = fbm(c * 2.1 - vec2(uTime * 0.05, uTime * 0.07));
  float v = mix(n1, n2, 0.5);

  // Color tint — warm where bass dominates, cool where treble dominates.
  vec3 warm = vec3(0.95, 0.32, 0.10);
  vec3 mid  = vec3(0.20, 0.95, 0.45);
  vec3 cool = vec3(0.20, 0.55, 1.00);
  float wWarm = uBass / max(uBass + uMid + uTreble, 1e-3);
  float wMid  = uMid  / max(uBass + uMid + uTreble, 1e-3);
  float wCool = uTreble / max(uBass + uMid + uTreble, 1e-3);
  vec3 tint = warm * wWarm + mid * wMid + cool * wCool;

  // Soft vignette so edges don't dominate.
  float vig = 1.0 - smoothstep(0.55, 1.05, r);
  // Baseline brightness so the field is visibly alive even when audio is silent.
  float intensity = 0.35 + 0.55 * (uBass + uMid + uTreble);
  vec3 col = tint * v * intensity;
  // Extra base wash of cool blue so the canvas isn't pitch black.
  col += vec3(0.04, 0.06, 0.12) * v * vig;
  col *= vig;

  gl_FragColor = vec4(col, 1.0);
}
`;

const BARS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const BARS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uBands[64];
uniform float uTime;
uniform float uBeat;

void main() {
  // Only paint the bottom 14% of the screen.
  if (vUv.y > 0.14) discard;
  // Each bar covers a horizontal slice; index from horizontal position.
  float bx = vUv.x * 64.0;
  int idx = int(floor(bx));
  if (idx < 0) idx = 0;
  if (idx > 63) idx = 63;

  // Bar interior is a soft vertical gradient up to height = uBands[idx].
  // Add a small floor so bars aren't completely empty in silence.
  float h = max(0.05, uBands[idx]);
  float yNorm = vUv.y / 0.14; // 0..1 from bottom strip
  float a = step(yNorm, h);
  // Soft top edge.
  a *= 1.0 - smoothstep(h - 0.06, h, yNorm);

  // Tiny gap between bars — modulus on bx fractional part.
  float gap = smoothstep(0.0, 0.06, fract(bx)) * smoothstep(0.0, 0.06, 1.0 - fract(bx));

  // Color: tilt warm at the low bands, cool at the high bands.
  float t = float(idx) / 63.0;
  vec3 col = mix(vec3(1.0, 0.55, 0.25), vec3(0.55, 0.85, 1.0), t);
  col *= 1.0 + 0.5 * uBeat;

  float alpha = a * gap * 0.85;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

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
  // Point size scaled to viewport height so it stays consistent across resizes.
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
  // Bright core with soft halo: combine a sharp inner gaussian with a wider one.
  float core = exp(-r2 * 28.0);
  float halo = exp(-r2 * 8.0) * 0.55;
  float alpha = core + halo;
  vec3 col = mix(uColorA, uColorB, vColorMix);
  // Slight per-particle twinkle via seed.
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

/** Build PARTICLE_COUNT (x,y) world-space target positions for the given
 *  word by rasterizing it to a hidden 2D canvas and randomly sampling its
 *  opaque pixels. */
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
  // Pick a font size so the word fills roughly 70% of the canvas width.
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
  // First pass: collect opaque pixel positions (sub-sampled by step 2 for perf).
  const samples: number[] = [];
  const step = 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      // R channel as proxy (text is white).
      if (data[i] > 128) samples.push(x, y);
    }
  }
  if (samples.length === 0) {
    // Fallback for empty/whitespace word: dot at origin.
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      out[i * 2 + 0] = (Math.random() - 0.5) * 2;
      out[i * 2 + 1] = (Math.random() - 0.5) * 0.6;
    }
    return out;
  }
  // Convert canvas px to world coords. Center the word at origin and scale so
  // its pixel-width maps to 2 * WORD_HALF_WIDTH world units.
  const sx = (2 * WORD_HALF_WIDTH) / w;
  const sy = sx; // preserve aspect
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const k = (Math.random() * (samples.length / 2)) | 0;
    const x = samples[k * 2];
    const y = samples[k * 2 + 1];
    // Tiny sub-pixel jitter so particles don't lock to integer pixels.
    out[i * 2 + 0] = (x - w / 2 + (Math.random() - 0.5) * step) * sx;
    out[i * 2 + 1] = -(y - h / 2 + (Math.random() - 0.5) * step) * sy;
  }
  return out;
}

// ---------- renderer ----------

interface FieldUniforms {
  uTime: { value: number };
  uRes: { value: THREE.Vector2 };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  [k: string]: THREE.IUniform;
}

interface BarsUniforms {
  uBands: { value: Float32Array };
  uTime: { value: number };
  uBeat: { value: number };
  [k: string]: THREE.IUniform;
}

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
  private fieldScene: THREE.Scene;
  private barsScene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private fullscreenCam: THREE.OrthographicCamera;
  private resizeObs: ResizeObserver;

  // Background field.
  private fieldMesh: THREE.Mesh;
  private fieldU: FieldUniforms;

  // Spectrogram bars.
  private barsMesh: THREE.Mesh;
  private barsU: BarsUniforms;
  private bandBuf = new Float32Array(BAND_COUNT);
  private bandSmooth = new Float32Array(BAND_COUNT);

  // Particles.
  private points: THREE.Points;
  private pGeo: THREE.BufferGeometry;
  private pPos: Float32Array;       // current world positions [x,y,z, ...]
  private pVel: Float32Array;       // velocities (xy only — z stays 0)
  private pHomeCur: Float32Array;   // current target [x,y per particle]
  private pHomeNext: Float32Array | null = null; // next target during transition
  private pTransitionAge = 1.0;     // 0..1 — 1 = settled
  private pSeeds: Float32Array;
  private pColorMix: Float32Array;
  private pU: ParticleUniforms;
  private cohesion = 0.85;          // 0 = chaos, 1 = full lock to homes

  // State.
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
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.fieldScene = new THREE.Scene();
    this.barsScene = new THREE.Scene();
    this.fullscreenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Particle scene uses an orthographic camera centered at origin, sized so
    // WORD_HALF_WIDTH world units fit comfortably horizontally.
    this.camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, -10, 10);

    // ----- field -----
    this.fieldU = {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    };
    this.fieldMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: FULL_VERT, fragmentShader: FIELD_FRAG,
        uniforms: this.fieldU as unknown as { [k: string]: THREE.IUniform },
        depthTest: false, depthWrite: false, transparent: true,
      })
    );
    this.fieldMesh.frustumCulled = false;
    this.fieldScene.add(this.fieldMesh);

    // ----- bars -----
    this.barsU = {
      uBands: { value: new Float32Array(BAND_COUNT) },
      uTime: { value: 0 }, uBeat: { value: 0 },
    };
    this.barsMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BARS_VERT, fragmentShader: BARS_FRAG,
        uniforms: this.barsU as unknown as { [k: string]: THREE.IUniform },
        depthTest: false, depthWrite: false, transparent: true,
        blending: THREE.AdditiveBlending,
      })
    );
    this.barsMesh.frustumCulled = false;
    this.barsScene.add(this.barsMesh);

    // ----- particles -----
    this.pGeo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(PARTICLE_COUNT * 3);
    this.pVel = new Float32Array(PARTICLE_COUNT * 2);
    this.pHomeCur = new Float32Array(PARTICLE_COUNT * 2);
    this.pSeeds = new Float32Array(PARTICLE_COUNT);
    this.pColorMix = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Initial: random scatter
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
    this.fieldU.uRes.value.set(w, h);
    this.pU.uViewportH.value = h;
    // Adjust ortho camera to match aspect — keep vertical extent fixed at 9 world units.
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

    // Pick the current word.
    const newIdx = this.findActiveTimingIdx(positionMs);
    if (newIdx !== this.activeTimingIdx) {
      this.activeTimingIdx = newIdx;
      const word = newIdx >= 0 ? this.allTimings[newIdx].text : null;
      if (word !== this.currentWord && word !== null) {
        this.startWordTransition(word);
      }
    }

    // Beat detection — Link first, audio onset fallback.
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

    // Update bands from FFT (or silently zero out).
    this.updateBands(audio?.fft ?? null);

    // Background uniforms.
    this.fieldU.uTime.value = this.elapsed;
    this.fieldU.uBass.value   = audio?.bass ?? 0;
    this.fieldU.uMid.value    = audio?.mid ?? 0;
    this.fieldU.uTreble.value = audio?.treble ?? 0;

    this.barsU.uTime.value = this.elapsed;
    this.barsU.uBeat.value = audio?.beat ?? 0;

    // Particle physics.
    this.tickParticles(dt, audio, beatRose, downbeat);

    // Glow decays.
    this.glow = Math.max(0, this.glow - dt * 2);
    if (beatRose) this.glow = Math.min(1.5, this.glow + (downbeat ? 0.9 : 0.6));
    this.pU.uGlow.value = this.glow;
    this.pU.uTime.value = this.elapsed;

    // Render: clear, field, bars, particles.
    this.renderer.clear();
    this.renderer.render(this.fieldScene, this.fullscreenCam);
    this.renderer.render(this.barsScene, this.fullscreenCam);
    this.renderer.render(this.scene, this.camera);
  }

  unmount(): void {
    this.resizeObs.disconnect();
    this.scene.remove(this.points);
    this.pGeo.dispose();
    (this.points.material as THREE.Material).dispose();
    this.fieldScene.remove(this.fieldMesh);
    (this.fieldMesh.material as THREE.Material).dispose();
    this.fieldMesh.geometry.dispose();
    this.barsScene.remove(this.barsMesh);
    (this.barsMesh.material as THREE.Material).dispose();
    this.barsMesh.geometry.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- internals ----

  private findActiveTimingIdx(positionMs: number): number {
    // Largest i where startMs <= positionMs and (i is last OR positionMs < endMs + 200ms)
    let lo = 0, hi = this.allTimings.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.allTimings[mid].startMs <= positionMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans < 0) return -1;
    const w = this.allTimings[ans];
    // Stay locked to the most-recent word for a beat or two after it ends so
    // the visual doesn't snap to an idle empty pose between words.
    if (positionMs > w.endMs + 1500 && ans + 1 < this.allTimings.length) {
      const nextStart = this.allTimings[ans + 1].startMs;
      if (positionMs < nextStart) return -1; // truly idle
    }
    return ans;
  }

  private startWordTransition(newWord: string): void {
    this.pHomeNext = sampleWordHomes(newWord);
    this.pTransitionAge = 0;
    this.currentWord = newWord;
    // Word-change blast: kick all particles outward (random direction
    // weighted from origin) so the transition reads as "old word disperses,
    // new word reforms".
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

    // Drive cohesion: tighter when a word is being sung, looser between words.
    const targetCohesion = this.activeTimingIdx >= 0 ? 1.0 : 0.55;
    this.cohesion += (targetCohesion - this.cohesion) * Math.min(1, dt * 4);

    // Word transition lerp (0 -> 1 over ~520ms).
    if (this.pHomeNext) {
      this.pTransitionAge = Math.min(1, this.pTransitionAge + dt * (1000 / 520));
      if (this.pTransitionAge >= 1) {
        this.pHomeCur = this.pHomeNext;
        this.pHomeNext = null;
      }
    }

    // Beat impulse — instantaneous radial velocity kick.
    const kickMag = beatRose ? BEAT_KICK * (downbeat ? DOWNBEAT_MULT : 1) * (0.5 + bass) : 0;
    // Per-frame jitter scaled by dt so 30 vs 60 fps look the same.
    const jitter = bass * BASS_JITTER * dt;

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

      // Spring acceleration (k * displacement) integrated over dt.
      const dx = tx - x;
      const dy = ty - y;
      vx += dx * k * this.cohesion * dt;
      vy += dy * k * this.cohesion * dt;

      // Bass jitter.
      if (jitter > 0) {
        vx += (Math.random() - 0.5) * jitter;
        vy += (Math.random() - 0.5) * jitter;
      }

      // Beat radial kick — instantaneous velocity bump (no dt scaling).
      if (kickMag > 0) {
        const r = Math.max(1e-3, Math.hypot(x, y));
        const m = kickMag * (0.5 + Math.random() * 0.5);
        vx += (x / r) * m;
        vy += (y / r) * m;
      }

      // Slow level-driven swirl.
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

  /** Update log-spaced FFT bands from the AudioFrame's linear bins. */
  private updateBands(fft: Float32Array | null): void {
    if (!fft || fft.length === 0) {
      // Decay smoothed bands.
      for (let i = 0; i < BAND_COUNT; i++) this.bandSmooth[i] *= 0.92;
      this.barsU.uBands.value = this.bandSmooth;
      return;
    }
    // Convert dB to linear amplitude and bin into log-spaced bands.
    const N = fft.length;
    // Cover roughly 30 Hz..16 kHz. We don't know sample rate here, but the
    // 512-bin FFT was built at the AudioContext sample rate (~48k or 44.1k);
    // the relative log distribution still reads musical even without exact Hz.
    for (let b = 0; b < BAND_COUNT; b++) {
      const tLo = b / BAND_COUNT;
      const tHi = (b + 1) / BAND_COUNT;
      // Log mapping into bin index.
      const loIdx = Math.max(1, Math.floor(Math.pow(N - 1, tLo)));
      const hiIdx = Math.max(loIdx + 1, Math.floor(Math.pow(N - 1, tHi)));
      let sum = 0, n = 0;
      for (let i = loIdx; i < hiIdx; i++) {
        const db = fft[i];
        if (!isFinite(db)) continue;
        sum += Math.pow(10, db / 20);
        n++;
      }
      const lin = n > 0 ? sum / n : 0;
      // Compress toward 0..1 with a soft knee.
      const v = Math.min(1, Math.pow(lin * 6, 0.7));
      // Smooth (ease in fast, ease out slow).
      const prev = this.bandSmooth[b];
      this.bandSmooth[b] = v > prev ? prev * 0.55 + v * 0.45 : prev * 0.86 + v * 0.14;
    }
    this.barsU.uBands.value = this.bandSmooth;
  }
}
