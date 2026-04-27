import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

// "Starfield" — transparent overlay vibe.
// Three layers of twinkling stars on a fully transparent background. Designed
// to layer-composite ON TOP of another vibe via the multi-canvas Stage. Bass
// hits add an additive global bloom so kicks momentarily light the whole field.

interface StarfieldUniforms {
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
uniform float uBeat;
uniform float uLevel;
uniform vec2  uRes;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uReact;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Render one layer of stars at the given cell scale.
// Returns vec2(intensity, hash) — hash used for color tinting.
vec2 layer(vec2 frag, float scale, float threshold, float layerSeed) {
  vec2 g = frag / scale;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id + layerSeed);
  if (h < threshold) return vec2(0.0, h);

  // Brighter when h is closer to 1.0 (rarer cells = brighter stars).
  float bright = (h - threshold) / max(1.0 - threshold, 1e-3);

  // Per-star gaussian blob. Tighter for brighter stars.
  float r2 = dot(f, f);
  float core = exp(-r2 * (60.0 + 80.0 * bright));

  // Per-star twinkle.
  float tw = 0.55 + 0.45 * sin(uTime * (1.2 + h * 4.0) + h * 6.28318);

  return vec2(core * tw * (0.4 + 0.9 * bright), h);
}

void main() {
  vec2 frag = vUv * uRes;

  // Three layers at increasing scales = sparser, larger stars.
  vec2 a = layer(frag, 18.0, 0.965, 0.0);
  vec2 b = layer(frag, 36.0, 0.945, 7.0);
  vec2 c = layer(frag, 72.0, 0.920, 19.0);

  float intensity = a.x + b.x + c.x;
  // Per-star hash drives color mix; weight by layer brightness so the
  // dominant star at any pixel decides its tint.
  float wsum = max(a.x + b.x + c.x, 1e-4);
  float hMix = (a.x * a.y + b.x * b.y + c.x * c.y) / wsum;

  // Bass adds an additive global bloom so kicks momentarily light up the field.
  intensity += uBass * uReact * 0.3;
  // Beat & level reinforce twinkle a touch.
  intensity *= 1.0 + 0.4 * uBeat * uReact;
  intensity += 0.05 * uLevel * uReact;
  intensity = clamp(intensity, 0.0, 1.6);

  vec3 starColor = mix(uColor, uAccent, hMix);

  // Output premultiplied — non-star pixels are fully transparent.
  float alpha = clamp(intensity, 0.0, 1.0);
  gl_FragColor = vec4(starColor * alpha, alpha);
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

  const uniforms: StarfieldUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uColor:  { value: new THREE.Color(0xffffff) },
    uAccent: { value: new THREE.Color(0xb8d8ff) },
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
    id: "starfield",
    name: "Starfield",
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
      if (p.color)  uniforms.uColor.value = parseHex(p.color, 0xffffff);
      if (p.accent) uniforms.uAccent.value = parseHex(p.accent, 0xb8d8ff);
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
