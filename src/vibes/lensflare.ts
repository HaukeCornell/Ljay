import * as THREE from "three";
import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

// "Lens flare" vibe: pure black field with a slow Lissajous-tracked sun,
// hexagonal star streaks, ghost reflections, and subtle chromatic aberration.
// Designed to composite cleanly under SCREEN blend on top of music video:
// dark pixels are pass-through, bright streaks/cores add into the video.

interface FlareUniforms {
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

// Warm-leaning IQ cosine palette (gold → orange → soft cyan accent).
vec3 palette(float t) {
  vec3 a = vec3(0.55, 0.45, 0.40);
  vec3 b = vec3(0.45, 0.40, 0.35);
  vec3 c = vec3(1.00, 1.00, 0.85);
  vec3 d = vec3(0.05, 0.15, 0.40);
  return a + b * cos(6.2832 * (c * t + d));
}

float gauss(float d, float k) {
  return exp(-d * d * k);
}

// Hexagonal star streaks: 6 spokes around the sun, falling off as 1/r,
// with a thin sin-modulated radial mask so they look like crisp blades.
float hexStreaks(vec2 p, float angleOffset) {
  float r = length(p);
  if (r < 1e-4) return 0.0;
  float a = atan(p.y, p.x) + angleOffset;
  // 6-fold blades, sharp peaks via |cos|^k
  float blades = pow(abs(cos(a * 3.0)), 28.0);
  // Fall off with distance, but not too fast so streaks reach mid-frame.
  float falloff = 1.0 / (1.0 + r * 9.0);
  // Soft radial flicker for "lens artifact" feel.
  float flick = 0.85 + 0.15 * sin(uTime * 1.7 + r * 12.0);
  return blades * falloff * flick;
}

// Single ghost element: small Gaussian along the line center→ghostAnchor,
// hue-rotated by tint. Position parameter t is signed: 0 = sun,
// 1 = ghost anchor, negative goes past center on the far side.
vec3 ghost(vec2 p, vec2 axis, float t, float radius, vec3 tint) {
  vec2 gp = axis * t;
  float d = length(p - gp);
  float g = gauss(d, 1.0 / max(radius * radius, 1e-5));
  return tint * g;
}

void main() {
  // Aspect-correct working space: keep flare round.
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv * 2.0 - 1.0);
  p.x *= aspect;

  // Slow Lissajous path for the sun, in screen-space (-aspect..aspect, -1..1).
  vec2 sunUv = vec2(0.5 + 0.18 * sin(uTime * 0.31),
                    0.5 + 0.13 * cos(uTime * 0.42));
  vec2 sun = (sunUv * 2.0 - 1.0);
  sun.x *= aspect;

  // Vector from sun to a fixed off-axis "ghost anchor" (typical lens-flare
  // pattern: ghosts march along the line through frame center).
  vec2 ghostAnchor = vec2(-0.65 * aspect, 0.45);
  vec2 axis = ghostAnchor - sun;

  vec2 d = p - sun;

  // ---- 1. Central core: tight Gaussian, beat-pulsed whiteout. ----
  float coreD = length(d);
  float core = gauss(coreD, 60.0) * (0.85 + 0.6 * uLevel);
  float beatPulse = clamp(uBeat, 0.0, 1.0);
  float whiteout = gauss(coreD, 18.0) * beatPulse;
  vec3 coreCol = vec3(1.0, 0.92, 0.78) * core;
  coreCol += vec3(1.0, 0.98, 0.95) * whiteout * 1.4;
  // A soft halo around the core so the screen blend feels luminous, not point-y.
  coreCol += vec3(1.0, 0.7, 0.35) * gauss(coreD, 6.0) * (0.18 + 0.25 * uLevel);

  // ---- 2. Hex streaks, bass-driven brightness, slow palette drift. ----
  float streak = hexStreaks(d, uTime * 0.07);
  // A second blade set, rotated, slightly fainter — gives the "polygonal aperture" feel.
  streak += 0.55 * hexStreaks(d, uTime * 0.07 + 0.5236);
  vec3 streakTint = palette(0.05 + uTime * 0.04 + uMid * 0.15);
  streakTint = mix(vec3(1.0, 0.85, 0.55), streakTint, 0.55); // keep warm bias
  vec3 streakCol = streakTint * streak * (0.6 + 1.4 * uBass + 0.5 * uLevel);

  // ---- 3. Ghost reflections along the sun→ghostAnchor axis. ----
  // Six small Gaussians at varied t values, hue-rotated by treble.
  float hue = uTime * 0.05 + uTreble * 0.6;
  vec3 c1 = palette(hue + 0.00) * 0.55;
  vec3 c2 = palette(hue + 0.18) * 0.55;
  vec3 c3 = palette(hue + 0.34) * 0.55;
  vec3 c4 = palette(hue + 0.55) * 0.55;
  vec3 c5 = palette(hue + 0.72) * 0.55;
  vec3 c6 = palette(hue + 0.92) * 0.55;

  vec3 ghosts = vec3(0.0);
  ghosts += ghost(p, axis, 0.30, 0.05 * aspect, c1);
  ghosts += ghost(p, axis, 0.55, 0.09 * aspect, c2);
  ghosts += ghost(p, axis, 0.80, 0.04 * aspect, c3);
  ghosts += ghost(p, axis, 1.10, 0.13 * aspect, c4);
  ghosts += ghost(p, axis, -0.25, 0.06 * aspect, c5);
  ghosts += ghost(p, axis, -0.55, 0.10 * aspect, c6);
  ghosts *= (0.55 + 0.5 * uLevel);

  // ---- 4. Chromatic aberration ring at the core. ----
  // Three offset Gaussian rings (R/G/B) at slightly different radii. Most
  // visible when the core is bright (uLevel high or on a beat).
  float ringR = abs(coreD - 0.06) ;
  float ringG = abs(coreD - 0.075);
  float ringB = abs(coreD - 0.090);
  float ringK = 220.0;
  float caStrength = 0.35 + 0.6 * uLevel + 0.35 * beatPulse;
  vec3 ca = vec3(
    gauss(ringR, ringK),
    gauss(ringG, ringK),
    gauss(ringB, ringK)
  ) * caStrength;

  // ---- Background: black with a faint nebula gradient toward sun side. ----
  // Stays nearly black so SCREEN blend leaves the underlying video alone.
  float bgFalloff = smoothstep(1.4, 0.2, length(d));
  vec3 bg = vec3(0.012, 0.008, 0.018) * bgFalloff;

  vec3 col = bg + coreCol + streakCol + ghosts + ca;

  // Soft global desaturation so screen blend doesn't blow out highlights.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.78); // ~78% saturation cap

  // Gentle filmic toe to keep darks dark (preserves video pass-through).
  col = max(col - 0.012, 0.0);

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

  const uniforms: FlareUniforms = {
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
    shadow: "0 0 18px rgba(0,0,0,0.85), 0 2px 14px rgba(0,0,0,0.7)",
    animation: "snippet",
    snippetWindow: 2,
    uppercase: true,
  };

  return {
    id: "lensflare",
    name: "Lens flare",
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
