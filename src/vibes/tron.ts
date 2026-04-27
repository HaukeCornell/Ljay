import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost, VibeParams } from "../types.ts";

// "Tron Grid" — transparent overlay vibe.
// A single perspective ground plane with a scrolling Tron-style grid; only the
// grid lines paint, everything else is fully transparent so the underlying
// vibe shows through. Mirrors the flythrough grid setup but stripped of the
// star backdrop and rebuilt around uColor (cyan-near) + uAccent (magenta-far).

interface GridUniforms {
  uTime: { value: number };
  uTravel: { value: number };
  uBeat: { value: number };
  uColor: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uReact: { value: number };
  [k: string]: THREE.IUniform;
}

function parseHex(hex: string | undefined, fallback: number): THREE.Color {
  if (typeof hex !== "string") return new THREE.Color(fallback);
  try { return new THREE.Color(hex); } catch { return new THREE.Color(fallback); }
}

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GRID_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform float uTime;
uniform float uTravel;
uniform float uBeat;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uReact;

void main() {
  // Scroll Z by time + travel; travel is bass-driven so kicks accelerate.
  float scrollZ = vWorld.z + uTime * 4.0 + uTravel * 8.0;
  vec2 gridUv = vec2(vWorld.x, scrollZ);
  vec2 g = abs(fract(gridUv * 0.45) - 0.5);
  float lineW = 0.025;
  float line = 1.0 - smoothstep(lineW, lineW + 0.02, min(g.x, g.y));

  // Fog by distance from camera (origin is roughly camera xz).
  float dist = length(vec2(vWorld.x, vWorld.z));
  float fog = 1.0 - smoothstep(8.0, 60.0, dist);

  // Cyan near → magenta far.
  vec3 colNear = uColor;
  vec3 colFar  = uAccent;
  vec3 lineCol = mix(colNear, colFar, smoothstep(2.0, 25.0, dist));
  lineCol *= 1.0 + uBeat * 0.6 * uReact;

  // Only grid lines paint; rest is fully transparent so the layer below shows through.
  float alpha = line * fog;
  vec3 col = lineCol * alpha * 1.2;

  gl_FragColor = vec4(col, alpha);
}
`;

export function create(): Vibe {
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let gridMesh: THREE.Mesh | null = null;
  let gridGeo: THREE.PlaneGeometry | null = null;
  let gridMat: THREE.ShaderMaterial | null = null;
  let unsubResize: (() => void) | null = null;
  let elapsed = 0;
  let travel = 0;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const gridU: GridUniforms = {
    uTime:   { value: 0 },
    uTravel: { value: 0 },
    uBeat:   { value: 0 },
    uColor:  { value: new THREE.Color(0x7cffb2) },
    uAccent: { value: new THREE.Color(0xff5ea8) },
    uReact:  { value: 0.7 },
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
    id: "tron",
    name: "Tron Grid",
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
      camera = new THREE.PerspectiveCamera(58, h.width / Math.max(1, h.height), 0.1, 200);
      camera.position.set(0, 1.4, 4);
      camera.lookAt(0, 0.6, -10);

      gridGeo = new THREE.PlaneGeometry(140, 140, 1, 1);
      gridMat = new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: gridU as unknown as { [k: string]: THREE.IUniform },
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      gridMesh = new THREE.Mesh(gridGeo, gridMat);
      gridMesh.rotation.x = -Math.PI / 2;
      gridMesh.position.set(0, -2.2, -40);
      scene.add(gridMesh);

      unsubResize = h.onResize((w, hpx) => {
        renderer?.setSize(w, hpx, false);
        if (camera) {
          camera.aspect = w / Math.max(1, hpx);
          camera.updateProjectionMatrix();
        }
      });
    },

    update(audio: AudioFrame | null, dtMs: number) {
      if (!renderer || !scene || !camera) return;
      const dt = (reducedMotion ? dtMs * 0.5 : dtMs) / 1000;
      elapsed += dt;

      // Travel approaches a bass-driven target smoothly.
      const targetTravel = audio ? audio.bass : 0;
      travel += (targetTravel - travel) * Math.min(1, dt * 4);

      const beatScale = reducedMotion ? 0.5 : 1;
      gridU.uTime.value = elapsed;
      gridU.uTravel.value = travel * (reducedMotion ? 0.4 : 1);
      gridU.uBeat.value = (audio?.beat ?? 0) * beatScale;

      renderer.render(scene, camera);
    },

    setParams(p: VibeParams) {
      if (p.color)  gridU.uColor.value = parseHex(p.color, 0x7cffb2);
      if (p.accent) gridU.uAccent.value = parseHex(p.accent, 0xff5ea8);
      if (typeof p.reactivity === "number") {
        gridU.uReact.value = Math.max(0, Math.min(3, p.reactivity));
      }
    },

    unmount() {
      unsubResize?.();
      if (gridMesh && scene) scene.remove(gridMesh);
      gridMat?.dispose();
      gridGeo?.dispose();
      renderer?.dispose();
      gridMesh = null;
      gridMat = null;
      gridGeo = null;
      scene = null;
      camera = null;
      renderer = null;
      unsubResize = null;
    },
  };
}
