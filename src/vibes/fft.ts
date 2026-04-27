import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

// "FFT Bars" — transparent overlay vibe.
// Renders 64 log-spaced FFT bars in the bottom 14% of the canvas. Designed to
// composite ON TOP of any vibe (the rest of the canvas stays fully transparent).
//
// The CPU-side `update` consumes `audio.fft` (Float32Array of dB values) and
// converts to a 64-band log-spaced array with knee + asymmetric easing, then
// uploads the smoothed bands as a uniform array.

const N_BANDS = 64;

interface FftUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  uBeat: { value: number };
  uLevel: { value: number };
  uRes: { value: THREE.Vector2 };
  uColor: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uReact: { value: number };
  uBands: { value: Float32Array };
  [k: string]: THREE.IUniform;
}

function parseHex(hex: string | undefined, fallback: number): THREE.Color {
  if (typeof hex !== "string") return new THREE.Color(fallback);
  try { return new THREE.Color(hex); } catch { return new THREE.Color(fallback); }
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uBeat;
uniform vec2  uRes;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uReact;
uniform float uBands[64];

const float BAR_REGION = 0.14;
const float N = 64.0;

void main() {
  // Outside the bar strip = fully transparent.
  if (vUv.y > BAR_REGION) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float bx = vUv.x * N;
  int idx = int(floor(bx));
  // GLSL ES 1.00: dynamic indexing of uniform float arrays is allowed in
  // fragment shaders on most desktop drivers. Three.js webgl1 should be ok.
  float h = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i == idx) { h = uBands[i]; break; }
  }
  h = clamp(h * uReact, 0.0, 1.2);

  // Bar height in [0, BAR_REGION].
  float barTop = h * BAR_REGION;
  // Soft top edge.
  float topEdge = smoothstep(barTop + 0.005, barTop - 0.005, vUv.y);

  // Gap between bars: shrink to ~80% of cell width.
  float frac = fract(bx);
  float gap = smoothstep(0.05, 0.10, frac) * smoothstep(0.95, 0.90, frac);

  // Color across spectrum.
  float t = float(idx) / 63.0;
  vec3 col = mix(uColor, uAccent, t);
  col *= 1.0 + 0.5 * uBeat;

  float alpha = topEdge * gap;
  // Slight floor glow from the very bottom up so bars feel grounded.
  alpha *= smoothstep(-0.02, 0.04, vUv.y);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export function create(): Vibe {
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let mat: THREE.ShaderMaterial | null = null;
  let geo: THREE.PlaneGeometry | null = null;
  let mesh: THREE.Mesh | null = null;
  let unsubResize: (() => void) | null = null;
  let elapsed = 0;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Smoothed band amplitudes 0..~1.
  const bands = new Float32Array(N_BANDS);

  const uniforms: FftUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uColor:  { value: new THREE.Color(0x7cffb2) },
    uAccent: { value: new THREE.Color(0x5b8cff) },
    uReact:  { value: 1.0 },
    uBands:  { value: bands },
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    shadow: "0 4px 24px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)",
    animation: "snippet",
    snippetWindow: 2,
  };

  // Compute log-spaced 64-band linear amplitudes from a dB FFT frame.
  // Mirrors the older lyricParticles `updateBands` logic: log-spaced bin
  // boundaries via Math.pow(N-1, b/64), dB→linear average, knee with
  // pow(lin*6, 0.7), asymmetric ease-in/out smoothing.
  function updateBands(fft: Float32Array, dt: number) {
    const N = fft.length;
    if (N === 0) return;
    // Asymmetric smoothing: rise fast, fall slow.
    const upK = Math.min(1, dt * 18);
    const dnK = Math.min(1, dt * 5);
    let prevIdx = 0;
    for (let b = 0; b < N_BANDS; b++) {
      const loIdx = Math.floor(Math.pow(N - 1, b / N_BANDS));
      const hiIdx = Math.max(loIdx + 1, Math.floor(Math.pow(N - 1, (b + 1) / N_BANDS)));
      const lo = Math.max(loIdx, prevIdx);
      const hi = Math.min(N, Math.max(lo + 1, hiIdx));
      prevIdx = hi;
      let sum = 0, n = 0;
      for (let i = lo; i < hi; i++) {
        const db = fft[i];
        if (!isFinite(db)) continue;
        sum += Math.pow(10, db / 20);
        n++;
      }
      const lin = n ? sum / n : 0;
      // Knee: lift quiet bins so the spectrum reads at typical mix levels.
      const target = Math.min(1.4, Math.pow(lin * 6, 0.7));
      const k = target > bands[b] ? upK : dnK;
      bands[b] = bands[b] + (target - bands[b]) * k;
    }
  }

  // Decay everything when audio is offline.
  function decayBands(dt: number) {
    const k = Math.min(1, dt * 3);
    for (let b = 0; b < N_BANDS; b++) bands[b] *= 1 - k;
  }

  return {
    id: "fft",
    name: "FFT Bars",
    lyricStyle,

    mount(h: VibeHost) {
      renderer = new THREE.WebGLRenderer({
        canvas: h.canvas,
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);
      renderer.setClearColor(0x000000, 0);

      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      geo = new THREE.PlaneGeometry(2, 2);
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      uniforms.uRes.value.set(h.width, h.height);

      unsubResize = h.onResize((w, hpx) => {
        renderer?.setSize(w, hpx, false);
        uniforms.uRes.value.set(w, hpx);
      });
    },

    update(audio: AudioFrame | null, dtMs: number) {
      if (!renderer || !scene || !camera) return;
      const dt = (reducedMotion ? dtMs * 0.5 : dtMs) / 1000;
      elapsed += dt;
      uniforms.uTime.value = elapsed;
      const beatScale = reducedMotion ? 0.5 : 1;

      if (audio) {
        uniforms.uBass.value = audio.bass;
        uniforms.uMid.value = audio.mid;
        uniforms.uTreble.value = audio.treble;
        uniforms.uBeat.value = audio.beat * beatScale;
        uniforms.uLevel.value = audio.level;
        if (audio.fft && audio.fft.length > 0) {
          updateBands(audio.fft, dt);
        } else {
          decayBands(dt);
        }
      } else {
        uniforms.uBass.value *= 0.9;
        uniforms.uMid.value *= 0.9;
        uniforms.uTreble.value *= 0.9;
        uniforms.uBeat.value *= 0.9;
        uniforms.uLevel.value *= 0.9;
        decayBands(dt);
      }
      renderer.render(scene, camera);
    },

    setParams(p: VibeParams) {
      if (p.color)  uniforms.uColor.value = parseHex(p.color, 0x7cffb2);
      if (p.accent) uniforms.uAccent.value = parseHex(p.accent, 0x5b8cff);
      if (typeof p.reactivity === "number") {
        uniforms.uReact.value = Math.max(0, Math.min(3, p.reactivity));
      }
    },

    unmount() {
      if (mesh && scene) scene.remove(mesh);
      mat?.dispose();
      geo?.dispose();
      unsubResize?.();
      renderer?.dispose();
      mesh = null;
      mat = null;
      geo = null;
      scene = null;
      camera = null;
      renderer = null;
      unsubResize = null;
    },
  };
}
