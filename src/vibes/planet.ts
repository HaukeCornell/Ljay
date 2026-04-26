import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

// "iTunes 3D planet" vibe: dark space, glowing displaced sphere with
// audio-reactive surface, bright fresnel rim, equatorial energy band that
// pulses on bass/beat, simple shader-driven star field behind.

const STAR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv * uRes;
  // Three layers of stars at different scales for depth/parallax feel.
  float total = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float scale = 28.0 + float(layer) * 46.0;
    vec2 g = uv / scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(layer) * 37.0);
    // ~6% density per layer → ~18% combined chance per cell
    if (h > 0.94) {
      float bright = (h - 0.94) / 0.06; // 0..1, brightest stars are rarest
      float d = length(f);
      float star = exp(-d * d * (90.0 + 60.0 * bright));
      // Twinkle.
      star *= 0.55 + 0.45 * sin(uTime * (1.2 + h * 4.0) + h * 6.28);
      total += star * (0.4 + 0.6 * bright);
    }
  }
  // Subtle background gradient — deep blue/purple toward bottom-left.
  vec3 bg = mix(vec3(0.01, 0.01, 0.03), vec3(0.04, 0.02, 0.08), vUv.y);
  vec3 col = bg + vec3(total) * (1.0 + uBass * 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

const PLANET_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPos;
varying vec3 vViewDir;
varying float vDisp;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uBeat;

// 3D simplex-ish noise (fast, good-enough turbulence).
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))
        +i.y+vec4(0.0,i1.y,i2.y,1.0))
        +i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float fbm(vec3 p) {
  float f = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { f += a * snoise(p); p *= 2.02; a *= 0.5; }
  return f;
}

void main() {
  vec3 p = position;
  // Slow rotation around Y so the planet visibly spins.
  float c = cos(uTime * 0.18);
  float s = sin(uTime * 0.18);
  p.xz = mat2(c, -s, s, c) * p.xz;

  // Audio-reactive displacement. Mid drives high-frequency wobble; bass
  // drives low-frequency surface bulges; beat punches a brief swell.
  float n = fbm(p * 1.6 + vec3(uTime * 0.3, 0.0, 0.0));
  float disp = 0.05 + 0.18 * uBass + 0.06 * uMid * sin(p.y * 8.0 + uTime * 2.0)
             + 0.10 * uBeat;
  vec3 displaced = p + normal * (n * disp);

  vDisp = n * disp;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vPos = mv.xyz;
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vPos;
varying vec3 vViewDir;
varying float vDisp;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uLevel;

vec3 palette(float t) {
  // Cyan / magenta / gold palette — leans iTunes-y.
  vec3 a = vec3(0.45, 0.30, 0.55);
  vec3 b = vec3(0.55, 0.45, 0.50);
  vec3 c = vec3(1.00, 1.00, 1.00);
  vec3 d = vec3(0.10, 0.30, 0.60);
  return a + b * cos(6.2832 * (c * t + d));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewDir);

  // Strong fresnel rim — brightens edges, darkens core.
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.4);

  // Latitude bands: subtle stripes via |y|.
  float bands = 0.5 + 0.5 * sin(n.y * 14.0 + uTime * 0.5 + uTreble * 3.0);
  bands = mix(0.85, 1.0, bands);

  // Base color shifts slowly around the palette + treble flick.
  vec3 base = palette(0.05 + uTime * 0.04 + n.x * 0.15 + uTreble * 0.1);
  // Core a bit darker, edges hot.
  vec3 col = base * (0.25 + 0.55 * bands);

  // Equatorial energy band — bright stripe near the equator that pulses on bass.
  float eq = exp(-pow(n.y * 8.0, 2.0));
  vec3 hot = vec3(0.7, 0.95, 1.0);
  col += hot * eq * (0.18 + 0.55 * uBass + 0.35 * uBeat);

  // Fresnel rim glow — keep this strong, it's the iTunes signature.
  vec3 rim = mix(vec3(0.4, 0.75, 1.0), vec3(0.95, 0.5, 0.85), 0.5 + 0.5 * sin(uTime * 0.3));
  col += rim * fres * (0.55 + uBeat * 0.6 + uLevel * 0.35);

  // Slight emissive boost on big displacement bumps so high-relief regions glow.
  col += vec3(0.3, 0.45, 0.85) * smoothstep(0.05, 0.18, abs(vDisp)) * (0.18 + 0.4 * uMid);

  // Slight contrast lift; don't crush so much that surface detail vanishes.
  col = pow(col, vec3(0.95));

  gl_FragColor = vec4(col, 1.0);
}
`;

interface PlanetUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uMid: { value: number };
  uTreble: { value: number };
  uBeat: { value: number };
  uLevel: { value: number };
  [k: string]: THREE.IUniform;
}

interface StarUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uRes: { value: THREE.Vector2 };
  [k: string]: THREE.IUniform;
}

export function create(): Vibe {
  let host: VibeHost | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let starMesh: THREE.Mesh | null = null;
  let planetMesh: THREE.Mesh | null = null;
  let unsubResize: (() => void) | null = null;
  let elapsed = 0;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const planetU: PlanetUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
  };
  const starU: StarUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  };

  const lyricStyle: LyricStyle = {
    font: '"Inter", -apple-system, system-ui, sans-serif',
    weight: 700,
    color: "#ffffff",
    shadow: "0 0 18px rgba(140,200,255,0.6), 0 2px 12px rgba(0,0,0,0.85)",
    animation: "snippet",
    snippetWindow: 2,
  };

  return {
    id: "planet",
    name: "Planet",
    lyricStyle,

    mount(h: VibeHost) {
      host = h;
      renderer = new THREE.WebGLRenderer({ canvas: h.canvas, alpha: false, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);
      renderer.autoClear = true;

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(45, h.width / Math.max(1, h.height), 0.1, 50);
      // Pull back so the planet sits as a 60%-of-height ball with breathing room for lyrics.
      camera.position.set(0, 0, 4.2);
      camera.lookAt(0, 0, 0);

      // Starfield: full-screen NDC quad rendered first with depth disabled.
      const starGeo = new THREE.PlaneGeometry(2, 2);
      const starMat = new THREE.ShaderMaterial({
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: starU as unknown as { [k: string]: THREE.IUniform },
        depthTest: false,
        depthWrite: false,
      });
      starMesh = new THREE.Mesh(starGeo, starMat);
      starMesh.frustumCulled = false;
      starMesh.renderOrder = 0;
      scene.add(starMesh);

      // Planet: subdivided icosahedron so the displacement looks smooth.
      const planetGeo = new THREE.IcosahedronGeometry(1.0, 64);
      const planetMat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
        uniforms: planetU as unknown as { [k: string]: THREE.IUniform },
      });
      planetMesh = new THREE.Mesh(planetGeo, planetMat);
      planetMesh.renderOrder = 1;
      scene.add(planetMesh);

      starU.uRes.value.set(h.width, h.height);

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
      if (!renderer || !scene || !camera) return;
      const dt = (reducedMotion ? dtMs * 0.5 : dtMs) / 1000;
      elapsed += dt;
      const beatScale = reducedMotion ? 0.5 : 1;

      planetU.uTime.value = elapsed;
      starU.uTime.value = elapsed;
      if (audio) {
        planetU.uBass.value = audio.bass;
        planetU.uMid.value = audio.mid;
        planetU.uTreble.value = audio.treble;
        planetU.uBeat.value = audio.beat * beatScale;
        planetU.uLevel.value = audio.level;
        starU.uBass.value = audio.bass;
      } else {
        planetU.uBass.value *= 0.92;
        planetU.uMid.value *= 0.92;
        planetU.uTreble.value *= 0.92;
        planetU.uBeat.value *= 0.92;
        planetU.uLevel.value *= 0.92;
        starU.uBass.value *= 0.92;
      }

      // Gentle camera bob — extra depth cue.
      camera.position.x = Math.sin(elapsed * 0.12) * 0.18;
      camera.position.y = Math.cos(elapsed * 0.09) * 0.10;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    },

    unmount() {
      if (planetMesh) {
        scene?.remove(planetMesh);
        planetMesh.geometry.dispose();
        (planetMesh.material as THREE.Material).dispose();
      }
      if (starMesh) {
        scene?.remove(starMesh);
        starMesh.geometry.dispose();
        (starMesh.material as THREE.Material).dispose();
      }
      unsubResize?.();
      renderer?.dispose();
      planetMesh = null;
      starMesh = null;
      scene = null;
      camera = null;
      renderer = null;
      host = null;
      unsubResize = null;
    },
  };
}
