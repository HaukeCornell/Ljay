import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

interface TunnelUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  uBeat: { value: number };
  uLevel: { value: number };
  uRes: { value: THREE.Vector2 };
  uColor:  { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uReact:  { value: number };
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

// Two-stop palette interpolated from the user's primary + accent. Beat phase
// drives a soft saturated highlight tinted slightly toward white.
vec3 palette(float t) {
  float w = 0.5 + 0.5 * cos(6.2832 * t);
  vec3 base = mix(uAccent, uColor, w);
  // Tiny rainbow lift so a fully-grey palette doesn't feel dead.
  vec3 lift = 0.06 * cos(6.2832 * (t + vec3(0.0, 0.33, 0.67)));
  return base + lift;
}

void main() {
  vec2 uv = vUv;
  // correct aspect so the tunnel is round, not stretched
  vec2 p = (uv * 2.0 - 1.0);
  p.x *= uRes.x / max(uRes.y, 1.0);

  float r = length(p);
  float a = atan(p.y, p.x);

  float u = 0.5 / max(r, 1e-3) + uTime * 0.5 * (1.0 + uBass * 2.0 * uReact);
  float v = a / 3.14159 + uTime * 0.05 * (1.0 + uMid * uReact);

  // checker-ish ribs
  float rib = 0.5 + 0.5 * sin(u * 6.2832 + uTreble * 4.0 * uReact);
  float band = 0.5 + 0.5 * sin(v * 6.2832 * 4.0);

  vec3 col = palette(fract(u * 0.5 + uMid * 0.2 * uReact));
  col *= mix(0.6, 1.0, rib);
  col += 0.08 * band;

  // beat pulse — multiplier scaled by reactivity
  col = mix(col, col * 1.5, clamp(uBeat * uReact, 0.0, 1.0));

  // level glow toward center, tinted by the active accent
  col += uAccent * 0.6 * uLevel * uReact * smoothstep(0.6, 0.0, r);

  // vignette / fade so the singularity isn't a white nuke
  col *= smoothstep(0.0, 0.4, r);
  col *= smoothstep(1.6, 0.6, r);

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

  const uniforms: TunnelUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uColor:  { value: new THREE.Color(0xff5ea8) }, // panel: "color"  (magenta)
    uAccent: { value: new THREE.Color(0x5b8cff) }, // panel: "accent" (cyan)
    uReact:  { value: 1.0 },
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    shadow: "0 4px 24px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)",
    animation: "snippet",
    snippetWindow: 2,
    uppercase: true,
  };

  return {
    id: "tunnel",
    name: "Tunnel",
    lyricStyle,

    mount(h: VibeHost) {
      host = h;
      // Reuse the canvas the Stage already created.
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
      if (p.color)  uniforms.uColor.value = parseHex(p.color, 0xff5ea8);
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
      host = null;
      unsubResize = null;
    },
  };
}
