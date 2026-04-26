import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

// "Halftone" vibe: black ink dots on near-white paper, cell grid in screen
// space. Designed to composite cleanly under MULTIPLY blend over a music
// video: white background = pass-through, black dots = ink that darkens.
// Bass thickens dots → bass hits visibly darken the video.

interface HalftoneUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  uBeat: { value: number };
  uLevel: { value: number };
  uRes: { value: THREE.Vector2 };
  uInk: { value: THREE.Color };
  uPaper: { value: THREE.Color };
  uReact: { value: number };
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
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uLevel;
uniform vec2  uRes;
uniform vec3  uInk;
uniform vec3  uPaper;
uniform float uReact;

// Cell size in screen pixels. ~30px feels right at 1080p; we keep it constant
// in pixel space so the dots don't change density on resize.
const float CELL_PX = 30.0;

// Cheap 2D hash (no period artifacts at this scale).
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 2D value noise — smooth, cheap, good enough for a slow breathing wave.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    f += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return f;
}

void main() {
  // Work in screen pixels so the grid is rotation-stable across aspect ratios.
  vec2 frag = vUv * uRes;

  // Slowly rotate the field by an angle driven by uMid — gives a "wave passing
  // through the print" feel without breaking the grid topology badly.
  float ang = 0.05 * sin(uTime * 0.13) + 0.10 * uMid;
  float ca = cos(ang), sa = sin(ang);
  vec2 centered = frag - 0.5 * uRes;
  vec2 rot = vec2(ca * centered.x - sa * centered.y,
                  sa * centered.x + ca * centered.y) + 0.5 * uRes;

  // Cell coordinate.
  vec2 cell = rot / CELL_PX;
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5; // -0.5..0.5 around cell center
  float distPx = length(f) * CELL_PX; // distance from cell center, in pixels

  // ---- Slow breathing noise field. Uses cell-space coords for stability. ----
  // Two scales: a coarse "page bend" and a finer ripple.
  float coarse = fbm(id * 0.06 + vec2(uTime * 0.10, uTime * 0.07));
  float fine = vnoise(id * 0.18 + vec2(0.0, uTime * 0.35));
  float breath = mix(coarse, fine, 0.35); // 0..1ish

  // ---- Audio-driven dot radius ----
  // Base radius in pixels. Cap at ~CELL/2 so neighbors only just kiss.
  float baseR = 4.5;                              // quiet baseline
  float bassR = 9.0 * uBass * uReact;             // bass fattens → multiply darkens
  float levelR = 4.0 * uLevel * uReact;
  float waveR = 5.5 * (breath - 0.5);             // spatial breathing
  float beatR = 3.5 * clamp(uBeat, 0.0, 1.0) * uReact;
  float radiusPx = baseR + bassR + levelR + waveR + beatR;
  // Clamp to physical cell — keep at least a thin gap so it never goes solid black.
  radiusPx = clamp(radiusPx, 0.5, CELL_PX * 0.48);

  // ---- Dot mask. Anti-aliased edge of ~1px. ----
  float aa = 1.0;
  float dot = 1.0 - smoothstep(radiusPx - aa, radiusPx + aa, distPx);

  // ---- Beat ink-splat: invert a few cells based on hash + beat threshold. ----
  // Stable per cell, but a different subset each beat (driven by uTime quantize).
  float beatBucket = floor(uTime * 6.0); // ~6 buckets/sec; ample variety
  float h = hash21(id + beatBucket);
  float splat = step(0.92, h) * clamp(uBeat, 0.0, 1.0); // ~8% of cells when beat=1
  dot = mix(dot, 1.0 - dot, splat);

  // ---- Compose colors (panel-customizable via uInk + uPaper) ----
  vec3 col = mix(uPaper, uInk, dot);

  // A barely-perceptible vignette so corners read slightly heavier in print.
  vec2 vp = vUv - 0.5;
  float vig = 1.0 - dot * 0.0;        // no-op placeholder
  vig = 1.0 - 0.10 * dot * dot * 0.0; // (kept here in case we ever lift it)
  // Actual vignette on paper, not on dots:
  float vmag = smoothstep(0.85, 0.45, length(vp));
  col = mix(col, col * 0.97, 1.0 - vmag);

  gl_FragColor = vec4(col, 1.0);
}
`;

export function create(): Vibe {
  let host: VibeHost | null = null;
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

  const uniforms: HalftoneUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uInk:   { value: new THREE.Color(0x0a0510) }, // panel: "color"
    uPaper: { value: new THREE.Color(0xf8f7f0) }, // panel: "accent"
    uReact: { value: 1.0 },
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", system-ui, sans-serif',
    weight: 900,
    color: "#0a0510",
    // Bright white halo + outline keeps text legible over the BW dot pattern
    // both standalone AND when MULTIPLY-blended under a music video.
    shadow: "0 2px 12px rgba(255,255,255,0.95), 0 0 0 4px #fff",
    animation: "snippet",
    snippetWindow: 2,
    uppercase: false,
  };

  return {
    id: "halftone",
    name: "Halftone",
    lyricStyle,

    mount(h: VibeHost) {
      host = h;
      renderer = new THREE.WebGLRenderer({ canvas: h.canvas, alpha: false, antialias: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);

      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      geo = new THREE.PlaneGeometry(2, 2);
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
        depthTest: false,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(geo, mat);
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
      } else {
        uniforms.uBass.value *= 0.9;
        uniforms.uMid.value *= 0.9;
        uniforms.uTreble.value *= 0.9;
        uniforms.uBeat.value *= 0.9;
        uniforms.uLevel.value *= 0.9;
      }
      renderer.render(scene, camera);
    },

    setParams(p: VibeParams) {
      if (p.color)  uniforms.uInk.value = parseHex(p.color, 0x0a0510);
      if (p.accent) uniforms.uPaper.value = parseHex(p.accent, 0xf8f7f0);
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
      host = null;
      unsubResize = null;
    },
  };
}
