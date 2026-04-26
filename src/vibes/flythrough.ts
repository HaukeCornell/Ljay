import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

// 90s demo-scene background:
//   - Bass-driven star streaks (warp speed)
//   - Tron-style perspective grid floor that scrolls forward as travel ramps
//   - Subtle camera bob and parallax
//
// PURE BACKGROUND — does NOT render lyrics. Pair with the `spatial` lyric mode
// to get the old "Fly-through" look (3D text flying through this scene), or
// any other lyric mode of your choice.

// ============================== Shaders ==============================

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uTravel;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv * uRes;
  vec2 c = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(c);

  float total = 0.0;
  for (int layer = 0; layer < 4; layer++) {
    float scale = 22.0 + float(layer) * 38.0;
    vec2 g = uv / scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(layer) * 37.0);
    if (h > 0.93) {
      float bright = (h - 0.93) / 0.07;
      vec2 streakDir = normalize(c + vec2(0.0001));
      float along = abs(dot(f, streakDir));
      float across = abs(dot(f, vec2(-streakDir.y, streakDir.x)));
      float streakLen = (0.05 + 0.55 * uBass + 0.45 * uTravel) * (0.4 + 0.6 * bright);
      float core = exp(-along * along / max(streakLen * streakLen, 1e-4))
                 * exp(-across * across * (180.0 + 120.0 * bright));
      core *= 0.55 + 0.45 * sin(uTime * (1.2 + h * 4.0) + h * 6.28);
      total += core * (0.5 + 0.5 * bright);
    }
  }
  vec3 bg = mix(vec3(0.02, 0.005, 0.06), vec3(0.005, 0.02, 0.05),
                smoothstep(0.0, 1.4, vUv.x + (1.0 - vUv.y)));
  float vig = 1.0 - smoothstep(0.5, 1.05, r);
  vec3 col = bg + vec3(total) * (1.0 + uBass * 0.4);
  col *= mix(0.7, 1.0, vig);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRID_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GRID_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform float uTime;
uniform float uTravel;
uniform float uBeat;

void main() {
  float scrollZ = vWorld.z + uTime * 4.0 + uTravel * 8.0;
  vec2 gridUv = vec2(vWorld.x, scrollZ);
  vec2 g = abs(fract(gridUv * 0.45) - 0.5);
  float lineW = 0.025;
  float line = 1.0 - smoothstep(lineW, lineW + 0.02, min(g.x, g.y));

  float dist = length(vec2(vWorld.x, vWorld.z));
  float fog = 1.0 - smoothstep(8.0, 60.0, dist);

  vec3 colNear = vec3(0.20, 0.85, 1.00);
  vec3 colFar  = vec3(1.00, 0.20, 0.65);
  vec3 line_col = mix(colNear, colFar, smoothstep(2.0, 25.0, dist));
  line_col *= 1.0 + uBeat * 0.6;

  vec3 col = line_col * line * fog * 1.2;
  col += vec3(0.02, 0.01, 0.05) * fog;
  gl_FragColor = vec4(col, fog);
}
`;

// ============================== Tunables ==============================

const CAMERA_BOB_Y = 0.22;
const CAMERA_BOB_PERIOD = 3.4;

interface StarUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uTravel: { value: number };
  uRes: { value: THREE.Vector2 };
  [k: string]: THREE.IUniform;
}

interface GridUniforms {
  uTime: { value: number };
  uTravel: { value: number };
  uBeat: { value: number };
  [k: string]: THREE.IUniform;
}

export interface FlythroughOptions {
  /** Reserved — historic flag from when this vibe owned its own 3D text.
   *  Currently a no-op; the vibe is always pure background. Pair with the
   *  `spatial` lyric mode if you want 3D text on top. */
  lyrics?: boolean;
}

export function create(_opts: FlythroughOptions = {}): Vibe {
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;

  let starScene: THREE.Scene | null = null;
  let starCam: THREE.OrthographicCamera | null = null;
  let starMesh: THREE.Mesh | null = null;
  const starU: StarUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uTravel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  };

  let gridMesh: THREE.Mesh | null = null;
  const gridU: GridUniforms = {
    uTime: { value: 0 },
    uTravel: { value: 0 },
    uBeat: { value: 0 },
  };

  let unsubResize: (() => void) | null = null;
  let elapsed = 0;
  let travel = 0;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const lyricStyle: LyricStyle = {
    // Suggestion only — picked by main.ts when lyric mode is "auto".
    // The vibe doesn't render anything itself.
    font: '"Inter", system-ui, sans-serif',
    weight: 800,
    color: "#ffffff",
    animation: "snippet",
    snippetWindow: 1,
  };

  return {
    id: "flythrough",
    name: "Fly-through",
    lyricStyle,

    mount(h: VibeHost) {
      renderer = new THREE.WebGLRenderer({ canvas: h.canvas, alpha: false, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);
      renderer.autoClear = false;

      scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x05031a, 12, 70);
      camera = new THREE.PerspectiveCamera(58, h.width / Math.max(1, h.height), 0.1, 200);
      camera.position.set(0, 1.4, 4);
      camera.lookAt(0, 0.6, -10);

      starScene = new THREE.Scene();
      starCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const starGeo = new THREE.PlaneGeometry(2, 2);
      const starMat = new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: starU as unknown as { [k: string]: THREE.IUniform },
        depthTest: false,
        depthWrite: false,
      });
      starMesh = new THREE.Mesh(starGeo, starMat);
      starMesh.frustumCulled = false;
      starScene.add(starMesh);
      starU.uRes.value.set(h.width, h.height);

      const gridGeo = new THREE.PlaneGeometry(140, 140, 1, 1);
      const gridMat = new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: gridU as unknown as { [k: string]: THREE.IUniform },
        transparent: true,
        depthWrite: false,
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
        starU.uRes.value.set(w, hpx);
      });
    },

    update(audio: AudioFrame | null, dtMs: number) {
      if (!renderer || !scene || !camera || !starScene || !starCam) return;
      const dt = (reducedMotion ? dtMs * 0.5 : dtMs) / 1000;
      elapsed += dt;

      const targetTravel = audio ? Math.max(audio.bass, audio.level * 0.6) : 0;
      travel += (targetTravel - travel) * Math.min(1, dt * 4);
      starU.uTime.value = elapsed;
      starU.uBass.value = audio?.bass ?? 0;
      starU.uTravel.value = travel * (reducedMotion ? 0.4 : 1);
      gridU.uTime.value = elapsed;
      gridU.uTravel.value = travel * (reducedMotion ? 0.4 : 1);
      gridU.uBeat.value = audio?.beat ?? 0;

      const bob = Math.sin(elapsed * Math.PI * 2 / CAMERA_BOB_PERIOD) * CAMERA_BOB_Y;
      camera.position.y = 1.4 + bob;
      camera.position.x = Math.cos(elapsed * 0.31) * 0.18;
      camera.lookAt(0, 0.6 + bob * 0.5, -10);

      renderer.clear();
      renderer.render(starScene, starCam);
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    unmount() {
      unsubResize?.();
      if (gridMesh) {
        scene?.remove(gridMesh);
        gridMesh.geometry.dispose();
        (gridMesh.material as THREE.Material).dispose();
      }
      if (starMesh) {
        starScene?.remove(starMesh);
        starMesh.geometry.dispose();
        (starMesh.material as THREE.Material).dispose();
      }
      renderer?.dispose();
      gridMesh = null;
      starMesh = null;
      starScene = null;
      starCam = null;
      camera = null;
      scene = null;
      renderer = null;
    },
  };
}
