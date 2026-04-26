import * as THREE from "three";
import type { AudioFrame, LyricLine, LyricStyle, Vibe, VibeHost } from "../types.ts";
import { subscribe } from "../state/store";

// Fly-through vibe: lyric lines as 3D-positioned text in space. Camera flies
// forward at constant speed; the playhead determines which line is currently
// at the camera. Past lines whoosh by; future lines recede into the distance.
//
// Background: WebGL starfield (same shader family as the Planet vibe).
// Foreground: pure CSS 3D transforms — gives us correct font rendering and
// per-word karaoke for free, much simpler than baked text geometry.
//
// This vibe owns its own lyric rendering, so it hides the standard lyric
// overlay while mounted.

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
uniform float uTravel; // accumulates over time -> warp-speed streaks

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv * uRes;
  // Normalize around center so we can do streaks aimed outward.
  vec2 c = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(c);

  // Star layers — denser, more depth than the Planet variant.
  float total = 0.0;
  for (int layer = 0; layer < 4; layer++) {
    float scale = 22.0 + float(layer) * 38.0;
    vec2 g = uv / scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(layer) * 37.0);
    if (h > 0.93) {
      float bright = (h - 0.93) / 0.07;
      float d = length(f);
      // Streak in the direction of motion (radial outward) — gives the
      // "Star Wars hyperspace" feel proportional to bass + travel speed.
      vec2 streakDir = normalize(c + vec2(0.0001));
      float along = abs(dot(f, streakDir));
      float across = abs(dot(f, vec2(-streakDir.y, streakDir.x)));
      float streakLen = (0.05 + 0.45 * uBass + 0.4 * uTravel) * (0.4 + 0.6 * bright);
      float core = exp(-along * along / max(streakLen * streakLen, 1e-4))
                 * exp(-across * across * (180.0 + 120.0 * bright));
      core *= 0.55 + 0.45 * sin(uTime * (1.2 + h * 4.0) + h * 6.28);
      total += core * (0.5 + 0.5 * bright);
    }
  }

  // Subtle nebula gradient — deep magenta toward bottom-left, deep teal top-right.
  vec3 bg = mix(
    vec3(0.02, 0.01, 0.04),
    vec3(0.005, 0.02, 0.05),
    smoothstep(0.0, 1.4, vUv.x + (1.0 - vUv.y))
  );

  // Vignette at edges to keep the eye centered.
  float vig = 1.0 - smoothstep(0.5, 1.05, r);
  vec3 col = bg + vec3(total) * (1.0 + uBass * 0.4);
  col *= mix(0.7, 1.0, vig);
  gl_FragColor = vec4(col, 1.0);
}
`;

interface StarUniforms {
  uTime: { value: number };
  uBass: { value: number };
  uTravel: { value: number };
  uRes: { value: THREE.Vector2 };
  [k: string]: THREE.IUniform;
}

const SPACING_PX = 600;       // virtual z-distance between consecutive lines
const PERSPECTIVE_PX = 800;   // CSS perspective (focal length)
const Z_OVERSHOOT_CAP_PX = 220; // clamp zoom-past so the line stays readable
const VISIBLE_AHEAD = 4;      // render this many lines into the distance
const VISIBLE_BEHIND = 1;     // render this many lines just past the camera
const PAST_FADE_PX = 600;     // how far past camera before line disappears

interface LineDom {
  el: HTMLDivElement;
  line: LyricLine;
  index: number;
  wordSpans: HTMLSpanElement[]; // index 0 = first word
  /** Per-word [startMs, endMs] for snippet brightness sweep. */
  wordTimings: { startMs: number; endMs: number }[];
}

export function create(): Vibe {
  let host: VibeHost | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.OrthographicCamera | null = null;
  let starMesh: THREE.Mesh | null = null;
  let unsubResize: (() => void) | null = null;
  let unsubState: (() => void) | null = null;
  let elapsed = 0;
  let travel = 0; // accumulated "perceived velocity" feed for the star shader
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const starU: StarUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uTravel: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  };

  let textRoot: HTMLDivElement | null = null;
  let textPerspective: HTMLDivElement | null = null;
  let originalLyricsDisplay: string | null = null;

  let lyricLines: LyricLine[] | null = null;
  let lineDoms: Map<number, LineDom> = new Map();
  let positionMs = 0;

  // We re-render line DOMs only when the lyrics array changes. Per-frame work
  // is just transform + opacity updates.
  function rebuildLines(lines: LyricLine[] | null): void {
    if (!textPerspective) return;
    textPerspective.replaceChildren();
    lineDoms.clear();
    if (!lines) return;
    // Pre-build all line DOMs but only show those near the camera each frame.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const el = document.createElement("div");
      el.className = "ljay-fly-line";
      const wordSpans: HTMLSpanElement[] = [];
      const timings = inferWordTimings(line);
      for (const w of timings) {
        const span = document.createElement("span");
        span.className = "ljay-fly-word";
        span.textContent = w.text;
        el.appendChild(span);
        // Add a real space so words actually have whitespace between them
        // (translateZ + inline-block collapse spaces otherwise).
        el.appendChild(document.createTextNode(" "));
        wordSpans.push(span);
      }
      textPerspective.appendChild(el);
      lineDoms.set(i, { el, line, index: i, wordSpans, wordTimings: timings });
    }
  }

  function findCurrentLineIndex(lines: LyricLine[], pos: number): number {
    // Largest i where line[i].startMs <= pos.
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].startMs <= pos) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function applyFly(): void {
    if (!textPerspective || !lyricLines || lyricLines.length === 0) return;
    const lines = lyricLines;
    const idx = findCurrentLineIndex(lines, positionMs);

    // fraction into the current line: 0 right when it starts, ~1 just before next.
    let frac = 0;
    if (idx >= 0) {
      const cur = lines[idx];
      const next = idx + 1 < lines.length ? lines[idx + 1] : null;
      const lineStart = cur.startMs;
      const lineEnd = next ? next.startMs : (cur.endMs ?? cur.startMs + 4000);
      const dur = Math.max(200, lineEnd - lineStart);
      frac = Math.max(0, Math.min(1, (positionMs - lineStart) / dur));
    } else {
      // Before any line begins: float the first line in from far away.
      const first = lines[0];
      const leadInMs = 4000;
      const tBefore = Math.max(0, first.startMs - positionMs);
      frac = -Math.min(1, tBefore / leadInMs);
    }

    for (const dom of lineDoms.values()) {
      // Offset by +0.5 so the *currently sung* line peaks at the camera
      // (z=0) at frac=0.5: it approaches from the distance at frac=0,
      // crashes through the viewer at the midpoint, and whooshes past
      // by the time the next line begins.
      const distLines = dom.index - (idx < 0 ? 0 : idx) - frac + 0.5;
      if (distLines > VISIBLE_AHEAD || distLines < -VISIBLE_BEHIND) {
        dom.el.style.display = "none";
        continue;
      }
      dom.el.style.display = "";
      // Cap the "zoom past camera" overshoot so the line remains readable
      // through its in-your-face moment instead of overflowing the screen.
      const rawZ = -distLines * SPACING_PX;
      const z = rawZ > Z_OVERSHOOT_CAP_PX ? Z_OVERSHOOT_CAP_PX : rawZ;
      dom.el.style.transform = `translate(-50%, -50%) translateZ(${z}px)`;

      // distLines > 0.5  -> not yet sung, in the distance, faint
      // distLines in [-0.5, 0.5] -> currently being sung, fully bright
      // distLines < -0.5 -> already passed, fade fast
      let opacity: number;
      if (distLines > 0.5) {
        const ahead = distLines - 0.5;  // 0..VISIBLE_AHEAD-0.5
        opacity = Math.max(0, 1 - ahead / VISIBLE_AHEAD);
        opacity *= 0.35 + 0.45 * Math.max(0, 1 - ahead / 1.8);
      } else if (distLines > -0.5) {
        opacity = 1;
      } else {
        const past = -distLines - 0.5;  // 0..VISIBLE_BEHIND-0.5
        opacity = Math.max(0, 1 - past * 2.2);
      }
      dom.el.style.opacity = String(opacity);

      // Per-word brightness sweep on the current line — gives a subtle
      // karaoke pulse, but every word stays clearly readable so the whole
      // line is legible whenever the line is visually "at the camera".
      if (dom.index === idx) {
        for (let i = 0; i < dom.wordSpans.length; i++) {
          const w = dom.wordTimings[i];
          let o: number;
          if (positionMs < w.startMs) o = 0.78;
          else if (positionMs > w.endMs) o = 1;
          else {
            const t = (positionMs - w.startMs) / Math.max(40, (w.endMs - w.startMs));
            o = 0.85 + 0.15 * Math.min(1, Math.max(0, t));
          }
          dom.wordSpans[i].style.opacity = String(o);
        }
      } else {
        for (const span of dom.wordSpans) span.style.opacity = "1";
      }
    }
  }

  const lyricStyle: LyricStyle = {
    // Vibe owns its own lyric rendering — these are unused for the standard
    // overlay (which we hide), but main.ts still calls setStyle.
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
      // ---- WebGL starfield on the canvas ----
      renderer = new THREE.WebGLRenderer({ canvas: h.canvas, alpha: false, antialias: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(h.width, h.height, false);
      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const starGeo = new THREE.PlaneGeometry(2, 2);
      const starMat = new THREE.ShaderMaterial({
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: starU as unknown as { [k: string]: THREE.IUniform },
        depthTest: false, depthWrite: false,
      });
      starMesh = new THREE.Mesh(starGeo, starMat);
      starMesh.frustumCulled = false;
      scene.add(starMesh);
      starU.uRes.value.set(h.width, h.height);

      // ---- DOM perspective layer for 3D text ----
      // Hide the standard lyric overlay so we own the karaoke layer.
      const std = document.getElementById("lyrics");
      if (std) {
        originalLyricsDisplay = std.style.display;
        std.style.display = "none";
      }

      textRoot = document.createElement("div");
      textRoot.className = "ljay-fly-root";
      Object.assign(textRoot.style, {
        position: "absolute",
        inset: "0",
        zIndex: "4",
        pointerEvents: "none",
        overflow: "hidden",
      } as CSSStyleDeclaration);
      textPerspective = document.createElement("div");
      textPerspective.className = "ljay-fly-perspective";
      Object.assign(textPerspective.style, {
        position: "absolute",
        inset: "0",
        perspective: PERSPECTIVE_PX + "px",
        perspectiveOrigin: "50% 50%",
        transformStyle: "preserve-3d",
      } as CSSStyleDeclaration);
      textRoot.appendChild(textPerspective);
      h.container.appendChild(textRoot);

      // Inject one-time CSS rules.
      let style = document.getElementById("ljay-fly-style") as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = "ljay-fly-style";
        style.textContent = FLY_CSS;
        document.head.appendChild(style);
      }

      // ---- subscribe to lyrics + position from app state ----
      let lastLyricsKey = "";
      unsubState = subscribe((s) => {
        positionMs = s.playhead
          ? s.playhead.positionMs + (performance.now() - s.playhead.anchorMs) * (s.playhead.rate || 1)
          : 0;
        const key = s.lyrics ? `${s.lyrics.trackKey}:${s.lyrics.lines.length}` : "none";
        if (key !== lastLyricsKey) {
          lastLyricsKey = key;
          lyricLines = s.lyrics?.lines ?? null;
          rebuildLines(lyricLines);
        }
      });

      unsubResize = h.onResize((w, hpx) => {
        renderer?.setSize(w, hpx, false);
        starU.uRes.value.set(w, hpx);
      });
    },

    update(audio: AudioFrame | null, dtMs: number) {
      if (!renderer || !scene || !camera) return;
      const dt = (reducedMotion ? dtMs * 0.5 : dtMs) / 1000;
      elapsed += dt;
      // travel accumulates with bass for warp-speed streaks
      const targetTravel = audio ? audio.bass : 0;
      travel += (targetTravel - travel) * Math.min(1, dt * 4);
      starU.uTime.value = elapsed;
      starU.uTravel.value = travel * (reducedMotion ? 0.5 : 1);
      starU.uBass.value = audio?.bass ?? 0;
      renderer.render(scene, camera);
      applyFly();
    },

    unmount() {
      unsubResize?.();
      unsubState?.();
      if (starMesh) {
        scene?.remove(starMesh);
        starMesh.geometry.dispose();
        (starMesh.material as THREE.Material).dispose();
      }
      renderer?.dispose();
      textRoot?.remove();
      // Restore the standard lyric overlay.
      const std = document.getElementById("lyrics");
      if (std) std.style.display = originalLyricsDisplay ?? "";
      lineDoms.clear();
      starMesh = null;
      scene = null;
      camera = null;
      renderer = null;
      textRoot = null;
      textPerspective = null;
      lyricLines = null;
      host = null;
    },
  };
}

// ---------- helpers ----------

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

const FLY_CSS = `
.ljay-fly-line {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  white-space: nowrap;
  font: 800 clamp(36px, 8vw, 120px)/1.05 "Inter", -apple-system, system-ui, sans-serif;
  letter-spacing: -0.01em;
  color: #fff;
  text-shadow:
    0 0 12px rgba(120,180,255,0.85),
    0 0 32px rgba(80,160,255,0.45),
    0 4px 18px rgba(0,0,0,0.95),
    0 0 1px #fff;
  will-change: transform, opacity;
  backface-visibility: hidden;
  transition: opacity 80ms linear;
}
.ljay-fly-word {
  display: inline-block;
  transition: opacity 90ms linear;
  padding: 0 0.02em;
}
`;
