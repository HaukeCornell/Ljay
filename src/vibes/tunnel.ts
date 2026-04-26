import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

interface TunnelUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  uBeat: { value: number };
  uLevel: { value: number };
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
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uLevel;
uniform vec2  uRes;

// magenta/cyan-leaning IQ cosine palette
vec3 palette(float t) {
  vec3 a = vec3(0.55, 0.40, 0.60);
  vec3 b = vec3(0.45, 0.55, 0.50);
  vec3 c = vec3(1.00, 1.00, 1.00);
  vec3 d = vec3(0.00, 0.20, 0.55); // shifts toward magenta + cyan
  return a + b * cos(6.2832 * (c * t + d));
}

void main() {
  vec2 uv = vUv;
  // correct aspect so the tunnel is round, not stretched
  vec2 p = (uv * 2.0 - 1.0);
  p.x *= uRes.x / max(uRes.y, 1.0);

  float r = length(p);
  float a = atan(p.y, p.x);

  float u = 0.5 / max(r, 1e-3) + uTime * 0.5 * (1.0 + uBass * 2.0);
  float v = a / 3.14159 + uTime * 0.05 * (1.0 + uMid);

  // checker-ish ribs
  float rib = 0.5 + 0.5 * sin(u * 6.2832 + uTreble * 4.0);
  float band = 0.5 + 0.5 * sin(v * 6.2832 * 4.0);

  vec3 col = palette(fract(u * 0.5 + uMid * 0.2));
  col *= mix(0.6, 1.0, rib);
  col += 0.08 * band;

  // beat pulse
  col = mix(col, col * 1.5, clamp(uBeat, 0.0, 1.0));

  // level glow toward center
  col += vec3(0.4, 0.1, 0.6) * uLevel * smoothstep(0.6, 0.0, r);

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
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    shadow: "0 4px 24px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.7)",
    animation: "fade",
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
