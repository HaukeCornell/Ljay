import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

interface MinimalUniforms {
  uTime: { value: number };
  uLevel: { value: number };
  uBeat: { value: number };
  uMix: { value: number };       // 0..1 ease between palettes A->B
  uColA1: { value: THREE.Color };
  uColA2: { value: THREE.Color };
  uColB1: { value: THREE.Color };
  uColB2: { value: THREE.Color };
  uRes: { value: THREE.Vector2 };
  [k: string]: THREE.IUniform;
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
uniform float uLevel;
uniform float uBeat;
uniform float uMix;
uniform vec3  uColA1;
uniform vec3  uColA2;
uniform vec3  uColB1;
uniform vec3  uColB2;
uniform vec2  uRes;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;

  // base = vertical gradient between two palette colors, eased between A and B
  vec3 c1 = mix(uColA1, uColB1, uMix);
  vec3 c2 = mix(uColA2, uColB2, uMix);
  vec3 base = mix(c1, c2, smoothstep(0.0, 1.0, uv.y));

  // faint vertical band whose brightness tracks uLevel
  float bandX = 0.5 + 0.18 * sin(uTime * 0.13);
  float band = smoothstep(0.06, 0.0, abs(uv.x - bandX));
  base += vec3(0.05, 0.06, 0.09) * band * (0.4 + uLevel * 1.2);

  // film grain
  float g = hash(uv * uRes + uTime * 60.0);
  base += (g - 0.5) * 0.045;

  gl_FragColor = vec4(base, 1.0);
}
`;

// dark slate palettes
const PALETTES: [THREE.Color, THREE.Color][] = [
  [new THREE.Color(0x0b1018), new THREE.Color(0x141a26)],
  [new THREE.Color(0x10131a), new THREE.Color(0x1a1422)],
  [new THREE.Color(0x0a1419), new THREE.Color(0x16202b)],
  [new THREE.Color(0x130d1a), new THREE.Color(0x21182d)],
];

export function create(): Vibe {
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let geo: THREE.PlaneGeometry | null = null;
  let mat: THREE.ShaderMaterial | null = null;
  let mesh: THREE.Mesh | null = null;
  let unsubResize: (() => void) | null = null;
  let elapsed = 0;
  let paletteIdx = 0;
  let mixT = 1; // start fully on palette A
  let mixDir = 0; // currently easing or not (1 = easing toward B)
  let prevBeat = 0;
  const SWAP_DURATION = 0.9; // seconds

  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const uniforms: MinimalUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uBeat: { value: 0 },
    uMix: { value: 1 },
    uColA1: { value: PALETTES[0][0].clone() },
    uColA2: { value: PALETTES[0][1].clone() },
    uColB1: { value: PALETTES[1][0].clone() },
    uColB2: { value: PALETTES[1][1].clone() },
    uRes: { value: new THREE.Vector2(1, 1) },
  };

  const lyricStyle: LyricStyle = {
    font: '"Helvetica Neue", "Arial", sans-serif',
    weight: 900,
    color: "#ffffff",
    animation: "snippet",
    snippetWindow: 1,
    uppercase: true,
  };

  function startSwap() {
    // Slide B -> A, queue next palette into B.
    uniforms.uColA1.value.copy(uniforms.uColB1.value);
    uniforms.uColA2.value.copy(uniforms.uColB2.value);
    paletteIdx = (paletteIdx + 1) % PALETTES.length;
    uniforms.uColB1.value.copy(PALETTES[paletteIdx][0]);
    uniforms.uColB2.value.copy(PALETTES[paletteIdx][1]);
    mixT = 0;
    mixDir = 1;
  }

  return {
    id: "minimal",
    name: "Minimal",
    lyricStyle,

    mount(h: VibeHost) {
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

      const beat = audio?.beat ?? 0;
      uniforms.uLevel.value = audio?.level ?? 0;
      uniforms.uBeat.value = beat;
      // Trigger swap on rising edge of beat (and only if we're not mid-swap)
      if (beat > 0.6 && prevBeat <= 0.6 && mixDir === 0) {
        startSwap();
      }
      prevBeat = beat;

      if (mixDir === 1) {
        mixT += dt / SWAP_DURATION;
        if (mixT >= 1) {
          mixT = 1;
          mixDir = 0;
        }
        // ease in-out cubic
        const t = mixT;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        // when mixT hits 1, B is now "current"; we keep uMix at 1 and on next swap we copy B into A.
        uniforms.uMix.value = eased;
      } else {
        uniforms.uMix.value = 1;
      }

      renderer.render(scene, camera);
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
