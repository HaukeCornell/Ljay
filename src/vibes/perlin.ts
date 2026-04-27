import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

// "Perlin Field" — transparent overlay vibe.
// Slow-moving 4-octave value-noise field, tinted by audio band weights.
// Always shows through somewhat (~0.55 base alpha), breathes with volume.

interface PerlinUniforms {
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
uniform float uLevel;
uniform float uBeat;
uniform vec2  uRes;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uReact;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

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
  for (int i = 0; i < 4; i++) {
    f += a * vnoise(p);
    p = p * 2.03 + vec2(0.13, 0.07);
    a *= 0.5;
  }
  return f;
}

void main() {
  // Aspect-correct uv around center.
  vec2 p = (vUv - 0.5);
  p.x *= uRes.x / max(uRes.y, 1.0);

  float scale = 2.4;
  vec2 drift = vec2(uTime * 0.07, uTime * 0.05) + vec2(uMid * 0.4, uTreble * 0.4) * uReact;
  float n = fbm(p * scale + drift);

  // Energy: bass/mid/treble combined, modulated by reactivity.
  float energy = clamp((uBass + uMid + uTreble) * 0.5 * uReact, 0.0, 1.5);

  // Tint between accent (low energy) and color (high energy), modulated by n.
  float t = clamp(n * (0.55 + 0.7 * energy), 0.0, 1.0);
  vec3 col = mix(uAccent, uColor, t);

  // Gentle beat lift.
  col *= 1.0 + 0.15 * uBeat * uReact;

  // Vignette: more pronounced toward center.
  float vd = length(p);
  float vig = smoothstep(1.1, 0.0, vd);

  // Base alpha 0.55 + breathes with level.
  float alpha = (0.55 + uLevel * uReact * 0.4) * vig;
  // Use noise to modulate alpha slightly so the field has texture, not a flat wash.
  alpha *= mix(0.75, 1.0, n);
  alpha = clamp(alpha, 0.0, 0.95);

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

  const uniforms: PerlinUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uColor:  { value: new THREE.Color(0x5b8cff) },
    uAccent: { value: new THREE.Color(0x1f2030) },
    uReact:  { value: 0.6 },
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    shadow: "0 4px 24px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)",
    animation: "snippet",
    snippetWindow: 2,
  };

  return {
    id: "perlin",
    name: "Perlin Field",
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
      if (p.color)  uniforms.uColor.value = parseHex(p.color, 0x5b8cff);
      if (p.accent) uniforms.uAccent.value = parseHex(p.accent, 0x1f2030);
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
