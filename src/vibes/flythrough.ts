import * as THREE from "three";
import { Text } from "troika-three-text";
import type { AudioFrame, LyricLine, LyricStyle, Vibe, VibeHost } from "../types.ts";
import { subscribe } from "../state/store";

// 90s demo-scene fly-through:
//   - Real 3D scene, perspective camera that drifts and bobs.
//   - Each LYRIC WORD is its own SDF Text mesh (troika-three-text) sitting at
//     its own world Z based on when it's sung. As time passes, the camera
//     glides forward; words approach, peak in your face, whoosh past.
//   - On activation each word springs in with a tasteful overshoot, picks up
//     emissive glow, and snaps back. Per-word karaoke comes for free.
//   - Background: bass-driven star streaks (warp speed) + a Tron-style
//     perspective grid floor that scrolls forward as the camera advances.
//
// This vibe owns its own lyric layer — the standard #lyrics overlay is
// hidden while it's mounted.

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
  // The grid scrolls toward the camera by warping vUv along Z.
  // We use world XZ for the grid coords so the scrolling is anchored to space,
  // not to the geometry.
  float scrollZ = vWorld.z + uTime * 4.0 + uTravel * 8.0;
  vec2 gridUv = vec2(vWorld.x, scrollZ);
  vec2 g = abs(fract(gridUv * 0.45) - 0.5);
  // Anti-aliased grid lines: bright where we're close to a half-cell boundary.
  float lineW = 0.025;
  float line = 1.0 - smoothstep(lineW, lineW + 0.02, min(g.x, g.y));

  // Distance fade — grid dies away into the horizon haze.
  float dist = length(vec2(vWorld.x, vWorld.z));
  float fog = 1.0 - smoothstep(8.0, 60.0, dist);

  // Cyan/magenta gradient on grid lines for that demo-scene cyberpunk look.
  vec3 colNear = vec3(0.20, 0.85, 1.00);
  vec3 colFar  = vec3(1.00, 0.20, 0.65);
  vec3 line_col = mix(colNear, colFar, smoothstep(2.0, 25.0, dist));
  // Beat pulse brightens lines briefly.
  line_col *= 1.0 + uBeat * 0.6;

  vec3 col = line_col * line * fog * 1.2;
  // Make the floor itself slightly tinted, not pure black, so the lit grid feels grounded.
  col += vec3(0.02, 0.01, 0.05) * fog;
  gl_FragColor = vec4(col, fog);
}
`;

// ============================== Tunables ==============================

/** Distance ahead of the camera at which the FUTURE-most word starts. */
const FAR_Z = -50;
/** Distance behind the camera at which words are despawned. */
const NEAR_Z = 4;
/** World units per millisecond — how fast time pushes words toward us. */
const FLY_SPEED_UPS = 0.020;
/** Spring physics for word activation scale. */
const SPRING_STIFFNESS = 320;
const SPRING_DAMPING = 12;
/** Camera Y bob amplitude / period. */
const CAMERA_BOB_Y = 0.22;
const CAMERA_BOB_PERIOD = 3.4;

interface WordEntry {
  /** Three.js Text instance. */
  text: any;
  /** Word's "due" time in track ms (from interpolated word timings). */
  startMs: number;
  endMs: number;
  /** Lateral offset within its line so words don't stack on each other in Z. */
  lineSlot: number;
  totalSlots: number;
  /** Hue for color-cycle, 0..1. */
  hue: number;
  // Spring state for scale on activation.
  scale: number;
  scaleVel: number;
  /** "Activeness" (0..1) to drive emissive intensity. */
  active: number;
  /** Per-word random offsets so they don't all wobble in sync. */
  jitterSeed: number;
}

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

// 90s demo palette — cyan, magenta, yellow, lime, orange.
const PALETTE = [
  new THREE.Color(0x00f6ff),
  new THREE.Color(0xff2bd6),
  new THREE.Color(0xffe600),
  new THREE.Color(0x6dff4f),
  new THREE.Color(0xff8a1e),
];

function colorForHue(h: number): THREE.Color {
  const t = (h % 1 + 1) % 1;
  const idx = t * PALETTE.length;
  const i0 = Math.floor(idx) % PALETTE.length;
  const i1 = (i0 + 1) % PALETTE.length;
  const f = idx - Math.floor(idx);
  return PALETTE[i0].clone().lerp(PALETTE[i1], f);
}

function inferWordTimings(line: LyricLine): { text: string; startMs: number; endMs: number }[] {
  const tokens = line.text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const lineEnd = line.endMs ?? line.startMs + Math.max(1500, tokens.length * 220);
  const lineDur = Math.max(200, lineEnd - line.startMs);
  if (line.words && line.words.length === tokens.length) {
    const out: { text: string; startMs: number; endMs: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const startMs = line.words[i].startMs;
      const endMs = i + 1 < line.words.length ? line.words[i + 1].startMs : lineEnd;
      out.push({ text: tokens[i], startMs, endMs });
    }
    return out;
  }
  const totalChars = tokens.reduce((s, t) => s + Math.max(1, t.length), 0);
  let cursor = line.startMs;
  const out: { text: string; startMs: number; endMs: number }[] = [];
  for (const t of tokens) {
    const share = Math.max(1, t.length) / totalChars;
    const slice = lineDur * share;
    out.push({ text: t, startMs: cursor, endMs: cursor + slice });
    cursor += slice;
  }
  return out;
}

export function create(): Vibe {
  let host: VibeHost | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;

  // Background star quad (renders first, ortho-projected via NDC trick).
  let starScene: THREE.Scene | null = null;
  let starCam: THREE.OrthographicCamera | null = null;
  let starMesh: THREE.Mesh | null = null;
  const starU: StarUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uTravel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  };

  // Tron grid floor.
  let gridMesh: THREE.Mesh | null = null;
  const gridU: GridUniforms = {
    uTime: { value: 0 },
    uTravel: { value: 0 },
    uBeat: { value: 0 },
  };

  // Word lifecycle.
  let words: WordEntry[] = [];
  /** Pre-built, sorted by startMs across the whole song. */
  let allTimings: { text: string; startMs: number; endMs: number; lineIdx: number; slot: number; totalSlots: number }[] = [];
  /** First index in allTimings whose word is still "live" (not despawned). */
  let activeStart = 0;
  /** Highest index already spawned. */
  let activeEnd = -1;

  let unsubResize: (() => void) | null = null;
  let unsubState: (() => void) | null = null;
  let lyricLinesKey = "";
  let originalLyricsDisplay: string | null = null;
  let elapsed = 0;
  let travel = 0;
  let positionMs = 0;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function rebuildTimings(lines: LyricLine[] | null): void {
    allTimings = [];
    activeStart = 0;
    activeEnd = -1;
    for (const w of words) {
      scene?.remove(w.text);
      w.text.dispose?.();
    }
    words = [];
    if (!lines) return;
    for (let i = 0; i < lines.length; i++) {
      const wt = inferWordTimings(lines[i]);
      const total = wt.length;
      for (let j = 0; j < wt.length; j++) {
        allTimings.push({
          text: wt[j].text,
          startMs: wt[j].startMs,
          endMs: wt[j].endMs,
          lineIdx: i,
          slot: j,
          totalSlots: total,
        });
      }
    }
  }

  function spawnWord(t: typeof allTimings[number], idxInList: number): WordEntry {
    const text = new Text();
    text.text = t.text;
    text.fontSize = 1.8;                   // chunky but small enough that long lines fit
    text.anchorX = "center";
    text.anchorY = "middle";
    text.outlineWidth = 0.08;
    text.outlineColor = 0x000000;
    text.outlineBlur = 0.06;
    text.outlineOpacity = 0.95;
    text.color = 0xffffff;
    text.fillOpacity = 1.0;
    text.frustumCulled = false;
    scene!.add(text);
    text.sync();

    const hue = (idxInList * 0.137) % 1;

    // Lateral spread within the line so words read left-to-right when the
    // line is at the camera. Spacing scales with word count so longer lines
    // don't run off the edges.
    const slotSpacing = t.totalSlots > 6 ? 2.4 : 2.8;
    const slotOffset = (t.slot - (t.totalSlots - 1) / 2) * slotSpacing;

    return {
      text,
      startMs: t.startMs,
      endMs: t.endMs,
      lineSlot: slotOffset,
      totalSlots: t.totalSlots,
      hue,
      scale: 0.001,
      scaleVel: 0,
      active: 0,
      jitterSeed: Math.random() * 6.28,
    };
  }

  function rebuildLines(lines: LyricLine[] | null): void {
    rebuildTimings(lines);
  }

  /** Convert a word's due time to its world Z. Future words are ahead of the
   * camera (negative Z, since the camera looks down -Z). */
  function zForTime(startMs: number): number {
    const tToDueMs = startMs - positionMs;
    return -tToDueMs * FLY_SPEED_UPS;
  }

  function updateWordWindow(): void {
    if (!scene) return;
    // Despawn words well behind the camera (z >> NEAR_Z).
    while (words.length > 0) {
      const head = words[0];
      const z = zForTime(head.startMs);
      if (z > NEAR_Z + 4) {
        scene.remove(head.text);
        head.text.dispose?.();
        words.shift();
        activeStart++;
      } else break;
    }
    // Spawn words that now fall inside the visible Z window.
    while (activeEnd + 1 < allTimings.length) {
      const next = allTimings[activeEnd + 1];
      const z = zForTime(next.startMs);
      if (z < FAR_Z) {
        // Still too deep in the future to spawn — wait.
        break;
      }
      if (z > NEAR_Z + 4) {
        // Already passed without ever being spawned (e.g., big seek). Skip.
        activeEnd++;
        continue;
      }
      words.push(spawnWord(next, activeEnd + 1));
      activeEnd++;
    }
  }

  function tickWords(dt: number): void {
    for (const w of words) {
      const z = zForTime(w.startMs);
      // Subtle position jitter for life — kept very small so the line stays
      // legible. Lateral position is the line slot (left-to-right reading).
      const jx = Math.sin(elapsed * 0.6 + w.jitterSeed) * 0.08;
      const jy = Math.cos(elapsed * 0.8 + w.jitterSeed * 1.3) * 0.06;
      w.text.position.set(w.lineSlot + jx, 0.6 + jy, z);

      // Activation: 1 while we're inside the word's sung window, 0 otherwise.
      const inside = positionMs >= w.startMs - 90 && positionMs <= w.endMs + 200;
      const target = inside ? 1.0 : 0.0;
      const accel = (target - w.active) * SPRING_STIFFNESS - w.scaleVel * SPRING_DAMPING;
      w.scaleVel += accel * dt;
      w.active += w.scaleVel * dt;
      if (w.active > 1.6) { w.active = 1.6; w.scaleVel *= -0.3; }
      if (w.active < -0.05) { w.active = -0.05; w.scaleVel *= -0.3; }

      // Springy scale: rest at 0.55, overshoots past 1.0 on activation.
      const scale = 0.55 + 0.85 * Math.max(0, w.active);
      w.text.scale.setScalar(scale);

      // Y-axis rotation as words approach gives the 3D feel — they don't read
      // as flat sprites. Spin gently around their own axis.
      const baseSpin = -elapsed * 0.4 + w.jitterSeed;
      const rotY = baseSpin * 0.15 + (w.active > 0.4 ? (w.active - 0.4) * 0.6 : 0);
      const rotZ = Math.sin(elapsed * 1.3 + w.jitterSeed) * 0.04
                 + (w.active > 0.6 ? (w.active - 0.6) * 0.3 : 0);
      w.text.rotation.set(0, rotY, rotZ);

      // Color: 90s palette cycling. Active words pop saturated; far/past dim.
      const baseColor = colorForHue(w.hue + elapsed * 0.06);
      const depthFade = THREE.MathUtils.clamp(1 - Math.max(0, -z) / 50, 0.25, 1);
      const passFade = z > 0 ? Math.max(0, 1 - z / 4) : 1;
      const colored = baseColor.clone().multiplyScalar(0.45 + 0.85 * w.active);
      w.text.color = colored.getHex();
      w.text.fillOpacity = THREE.MathUtils.clamp(depthFade * passFade, 0, 1);
      w.text.outlineColor = w.active > 0.4 ? 0x202040 : 0x000000;
      w.text.outlineOpacity = 0.8 + 0.2 * w.active;
    }
  }

  const lyricStyle: LyricStyle = {
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
      host = h;

      renderer = new THREE.WebGLRenderer({ canvas: h.canvas, alpha: false, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);
      renderer.autoClear = false;

      // Foreground 3D scene.
      scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x05031a, 12, 70);
      camera = new THREE.PerspectiveCamera(58, h.width / Math.max(1, h.height), 0.1, 200);
      camera.position.set(0, 1.4, 4);
      camera.lookAt(0, 0.6, -10);

      // Background star quad — own scene/cam, drawn first.
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

      // Tron-style perspective grid floor.
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

      // Hide standard lyric overlay — we own lyrics here.
      const std = document.getElementById("lyrics");
      if (std) {
        originalLyricsDisplay = std.style.display;
        std.style.display = "none";
      }

      // State subscription.
      unsubState = subscribe((s) => {
        positionMs = s.playhead
          ? s.playhead.positionMs + (performance.now() - s.playhead.anchorMs) * (s.playhead.rate || 1)
          : 0;
        const key = s.lyrics ? `${s.lyrics.trackKey}:${s.lyrics.lines.length}` : "none";
        if (key !== lyricLinesKey) {
          lyricLinesKey = key;
          rebuildLines(s.lyrics?.lines ?? null);
        }
      });

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

      // Smooth travel value drives both star streaks and grid scroll speed.
      const targetTravel = audio ? Math.max(audio.bass, audio.level * 0.6) : 0;
      travel += (targetTravel - travel) * Math.min(1, dt * 4);
      starU.uTime.value = elapsed;
      starU.uBass.value = audio?.bass ?? 0;
      starU.uTravel.value = travel * (reducedMotion ? 0.4 : 1);
      gridU.uTime.value = elapsed;
      gridU.uTravel.value = travel * (reducedMotion ? 0.4 : 1);
      gridU.uBeat.value = audio?.beat ?? 0;

      // Camera bob — gives the scene "breathing" without losing readability.
      const bob = Math.sin(elapsed * Math.PI * 2 / CAMERA_BOB_PERIOD) * CAMERA_BOB_Y;
      camera.position.y = 1.4 + bob;
      camera.position.x = Math.cos(elapsed * 0.31) * 0.18;
      camera.lookAt(0, 0.6 + bob * 0.5, -10);

      // Manage word lifecycle and per-frame physics.
      updateWordWindow();
      tickWords(dt);

      // Render order: clear, draw stars, then 3D scene.
      renderer.clear();
      renderer.render(starScene, starCam);
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    unmount() {
      unsubResize?.();
      unsubState?.();
      // Dispose word meshes.
      for (const w of words) {
        scene?.remove(w.text);
        w.text.dispose?.();
        (w.text.material as THREE.Material | undefined)?.dispose?.();
      }
      words = [];
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
      // Restore standard lyric overlay.
      const std = document.getElementById("lyrics");
      if (std) std.style.display = originalLyricsDisplay ?? "";
      gridMesh = null;
      starMesh = null;
      starScene = null;
      starCam = null;
      camera = null;
      scene = null;
      renderer = null;
      host = null;
    },
  };
}
