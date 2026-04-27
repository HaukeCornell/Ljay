import type { AudioFrame, LinkState, LyricLine, LyricStyle } from "../types";
import { Lyric3DRenderer } from "./lyric3d";
import { LyricParticlesRenderer } from "./lyricParticles";

const SCRUB_THRESHOLD_MS = 1500;

const DEFAULT_STYLE: LyricStyle = {
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
  weight: 700,
  color: "#ffffff",
  animation: "scroll",
};

type Animation = LyricStyle["animation"];

export class LyricScene {
  private host: HTMLElement;
  private currentEl: HTMLDivElement;
  private nextEl: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private style: LyricStyle = DEFAULT_STYLE;
  /** Panel-driven overrides keyed off the active animation. Merged on top of
   *  whatever the active vibe's `lyricStyle` provided. */
  private overrides: { color?: string; accent?: string; reactivity?: number } = {};
  private visible = true;
  private hold = false;
  private spatial: Lyric3DRenderer | null = null;
  private particles: LyricParticlesRenderer | null = null;
  private lastPositionForSpatial = 0;
  private lastSpatialTickT = 0;
  private lastParticlesTickT = 0;
  private currentIndex = -1;
  private prevIndex = -1;
  private lastPositionMs = 0;
  private renderedLineKey = ""; // text|startMs of currently displayed line
  private typewriterTimer: number | null = null;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.replaceChildren();

    this.styleEl = document.createElement("style");
    this.styleEl.textContent = LYRIC_CSS;
    this.host.appendChild(this.styleEl);

    this.currentEl = document.createElement("div");
    this.currentEl.className = "ljay-line ljay-line-current";
    this.nextEl = document.createElement("div");
    this.nextEl.className = "ljay-line ljay-line-next";

    this.host.appendChild(this.currentEl);
    this.host.appendChild(this.nextEl);

    this.applyStyle();
  }

  setStyle(style: LyricStyle): void {
    this.style = { ...DEFAULT_STYLE, ...style };
    this.applyStyle();
    this.syncSpatialMode();
    // Re-apply existing panel overrides so spatial/particles renderers
    // adopt the panel's color/reactivity even after a fresh mount.
    this.pushOverridesToRenderers();
  }

  /** Apply panel-driven param overrides (color / accent / reactivity) for
   *  the currently-active animation. Pass `{}` to clear. */
  setOverrides(o: { color?: string; accent?: string; reactivity?: number }): void {
    this.overrides = { ...this.overrides, ...o };
    this.applyStyle();
    this.pushOverridesToRenderers();
  }

  private pushOverridesToRenderers(): void {
    // The merged values that should drive renderers: panel override beats
    // vibe lyricStyle default (only `color` lives on LyricStyle today).
    const merged = {
      color: this.overrides.color ?? this.style.color,
      accent: this.overrides.accent,
      reactivity: this.overrides.reactivity,
    };
    this.spatial?.setColors(merged);
    this.particles?.setColors(merged);
  }

  /** Mount or unmount the 3D spatial / particles renderers based on
   *  the active animation. Both modes own the lyric layer entirely. */
  private syncSpatialMode(): void {
    const wantSpatial = this.style.animation === "spatial";
    const wantParticles = this.style.animation === "particles";
    const wantOwnsLyrics = wantSpatial || wantParticles;

    if (wantSpatial && !this.spatial) {
      this.currentEl.style.display = "none";
      this.nextEl.style.display = "none";
      this.spatial = new Lyric3DRenderer(this.host);
      this.spatial.setHold(this.hold);
    } else if (!wantSpatial && this.spatial) {
      this.spatial.unmount();
      this.spatial = null;
    }

    if (wantParticles && !this.particles) {
      this.currentEl.style.display = "none";
      this.nextEl.style.display = "none";
      this.particles = new LyricParticlesRenderer(this.host);
      this.particles.setHold(this.hold);
    } else if (!wantParticles && this.particles) {
      this.particles.unmount();
      this.particles = null;
    }

    if (!wantOwnsLyrics) {
      this.currentEl.style.display = "";
      this.nextEl.style.display = "";
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.host.style.display = v ? "" : "none";
    this.spatial?.setVisible(v);
    this.particles?.setVisible(v);
  }

  setHold(v: boolean): void {
    this.hold = v;
    this.spatial?.setHold(v);
    this.particles?.setHold(v);
  }

  update(positionMs: number, lines: LyricLine[] | null, audio: AudioFrame | null = null, link: LinkState | null = null): void {
    if (!this.visible || this.disposed) return;

    // Spatial 3D mode owns its own renderer — feed it position + dt + audio + link.
    if (this.spatial) {
      const now = performance.now();
      const dtMs = this.lastSpatialTickT === 0 ? 16 : Math.max(1, Math.min(64, now - this.lastSpatialTickT));
      this.lastSpatialTickT = now;
      this.spatial.setLines(lines);
      this.spatial.update(positionMs, dtMs, audio, link);
      this.lastPositionForSpatial = positionMs;
      return;
    }

    // Particles mode also owns its own renderer.
    if (this.particles) {
      const now = performance.now();
      const dtMs = this.lastParticlesTickT === 0 ? 16 : Math.max(1, Math.min(64, now - this.lastParticlesTickT));
      this.lastParticlesTickT = now;
      this.particles.setLines(lines);
      this.particles.update(positionMs, dtMs, audio, link);
      return;
    }

    const dt = positionMs - this.lastPositionMs;
    const scrubbed = Math.abs(dt) > SCRUB_THRESHOLD_MS;
    this.lastPositionMs = positionMs;

    if (!lines || lines.length === 0) {
      if (this.renderedLineKey !== "") {
        this.clearLines();
      }
      return;
    }

    const idx = findLineIndex(lines, positionMs);
    const line = idx >= 0 ? lines[idx] : null;
    const next = idx + 1 < lines.length ? lines[idx + 1] : null;

    if (idx !== this.currentIndex) {
      this.prevIndex = this.currentIndex;
      this.currentIndex = idx;
      this.renderTransition(line, next, scrubbed);
    } else {
      // Same line: maybe still need to refresh next preview if it changed.
      this.refreshNext(next);
    }

    if (line) {
      this.applyWordHighlight(line, positionMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.typewriterTimer !== null) {
      window.clearInterval(this.typewriterTimer);
      this.typewriterTimer = null;
    }
    this.spatial?.unmount();
    this.spatial = null;
    this.particles?.unmount();
    this.particles = null;
    this.host.replaceChildren();
  }

  // -------- internals --------

  private applyStyle(): void {
    const s = this.style;
    const transform = s.uppercase ? "uppercase" : "none";
    const color = this.overrides.color ?? s.color;
    for (const el of [this.currentEl, this.nextEl]) {
      el.style.fontFamily = s.font;
      el.style.fontWeight = String(s.weight);
      el.style.color = color;
      el.style.textShadow = s.shadow ?? "";
      el.style.textTransform = transform;
    }
    // Animation flavor → class on host
    this.host.dataset.animation = s.animation;
  }

  private clearLines(): void {
    this.cancelTypewriter();
    this.currentEl.textContent = "";
    this.nextEl.textContent = "";
    this.renderedLineKey = "";
    this.currentIndex = -1;
    this.prevIndex = -1;
  }

  private refreshNext(next: LyricLine | null): void {
    const txt = next?.text ?? "";
    if (this.nextEl.textContent !== txt) {
      this.nextEl.textContent = txt;
    }
  }

  private renderTransition(line: LyricLine | null, next: LyricLine | null, scrubbed: boolean): void {
    this.cancelTypewriter();
    const animation: Animation = this.style.animation;

    if (!line) {
      this.currentEl.textContent = "";
      this.nextEl.textContent = next?.text ?? "";
      this.renderedLineKey = "";
      return;
    }

    const key = lineKey(line);
    this.renderedLineKey = key;

    if (scrubbed) {
      this.hardCut(line, next, animation);
      return;
    }

    switch (animation) {
      case "scroll":
        this.animateScroll(line, next);
        break;
      case "typewriter":
        this.animateTypewriter(line, next);
        break;
      case "fade":
        this.animateFade(line);
        break;
      case "bounce":
        this.animateBounce(line, next);
        break;
      case "snippet":
        this.animateSnippet(line, next);
        break;
      case "subtitle":
        this.animateSubtitle(line);
        break;
      case "karaoke":
        this.animateKaraoke(line);
        break;
    }
  }

  /** Broadcast TV-style subtitle: single line, anchored bottom, dark scrim. */
  private animateSubtitle(line: LyricLine): void {
    this.currentEl.textContent = line.text;
    this.nextEl.textContent = "";
    this.currentEl.classList.remove("ljay-enter");
    void this.currentEl.offsetWidth;
    this.currentEl.classList.add("ljay-enter");
  }

  /** Classic karaoke: whole line rendered with per-word fill that sweeps L→R. */
  private animateKaraoke(line: LyricLine): void {
    this.renderKaraokeWords(this.currentEl, line);
    this.nextEl.textContent = "";
  }

  private renderKaraokeWords(host: HTMLDivElement, line: LyricLine): void {
    host.replaceChildren();
    const words = inferWordTimings(line);
    for (const w of words) {
      const span = document.createElement("span");
      span.className = "ljay-word ljay-karaoke-word";
      span.dataset.start = String(w.startMs);
      span.dataset.end = String(w.endMs);
      // Layered: a dim base layer + a bright fill layer that animates a
      // left-to-right wipe via clip-path as the word's sing-window plays.
      const base = document.createElement("span");
      base.className = "ljay-karaoke-base";
      base.textContent = w.text;
      const fill = document.createElement("span");
      fill.className = "ljay-karaoke-fill";
      fill.textContent = w.text;
      fill.style.clipPath = "inset(0 100% 0 0)";
      span.appendChild(base);
      span.appendChild(fill);
      host.appendChild(span);
    }
  }

  private animateSnippet(line: LyricLine, next: LyricLine | null): void {
    // Word-windowed karaoke: render every word of the line as a span with a
    // per-word startMs (real if present, else interpolated). The host frame
    // loop calls applyWordHighlight() each tick to advance the visible window.
    this.renderSnippetWords(this.currentEl, line);
    this.nextEl.textContent = next?.text ?? "";
  }

  private renderSnippetWords(host: HTMLDivElement, line: LyricLine): void {
    host.replaceChildren();
    const words = inferWordTimings(line);
    for (const w of words) {
      const span = document.createElement("span");
      span.className = "ljay-word ljay-snippet-word";
      span.dataset.start = String(w.startMs);
      span.dataset.end = String(w.endMs);
      span.textContent = w.text;
      host.appendChild(span);
    }
  }

  private hardCut(line: LyricLine, next: LyricLine | null, animation: Animation): void {
    if (animation === "typewriter" || animation === "subtitle") {
      this.currentEl.textContent = line.text;
    } else if (animation === "snippet") {
      this.renderSnippetWords(this.currentEl, line);
    } else if (animation === "karaoke") {
      this.renderKaraokeWords(this.currentEl, line);
    } else {
      this.renderWords(this.currentEl, line);
    }
    this.nextEl.textContent = animation === "fade" || animation === "subtitle" || animation === "karaoke" ? "" : (next?.text ?? "");
    // Reset animation classes.
    this.currentEl.classList.remove("ljay-enter", "ljay-exit", "ljay-bounce");
    this.nextEl.classList.remove("ljay-enter", "ljay-exit", "ljay-bounce");
  }

  private animateScroll(line: LyricLine, next: LyricLine | null): void {
    this.renderWords(this.currentEl, line);
    this.nextEl.textContent = next?.text ?? "";
    this.currentEl.classList.remove("ljay-enter");
    void this.currentEl.offsetWidth; // restart animation
    this.currentEl.classList.add("ljay-enter");
  }

  private animateTypewriter(line: LyricLine, next: LyricLine | null): void {
    const duration = computeTypewriterMs(line);
    const text = line.text;
    const stepMs = Math.max(16, duration / Math.max(1, text.length));
    let i = 0;
    this.currentEl.textContent = "";
    this.nextEl.textContent = next?.text ?? "";
    this.typewriterTimer = window.setInterval(() => {
      i++;
      this.currentEl.textContent = text.slice(0, i);
      if (i >= text.length) this.cancelTypewriter();
    }, stepMs);
  }

  private animateFade(line: LyricLine): void {
    this.renderWords(this.currentEl, line);
    this.nextEl.textContent = "";
    this.currentEl.classList.remove("ljay-fade-in");
    void this.currentEl.offsetWidth;
    this.currentEl.classList.add("ljay-fade-in");
  }

  private animateBounce(line: LyricLine, next: LyricLine | null): void {
    this.renderWordsBounce(this.currentEl, line);
    this.nextEl.textContent = next?.text ?? "";
  }

  private renderWords(host: HTMLDivElement, line: LyricLine): void {
    host.replaceChildren();
    if (line.words && line.words.length > 0) {
      for (const w of line.words) {
        const span = document.createElement("span");
        span.className = "ljay-word";
        span.dataset.start = String(w.startMs);
        span.textContent = w.text;
        host.appendChild(span);
        host.appendChild(document.createTextNode(" "));
      }
    } else {
      host.textContent = line.text;
    }
  }

  private renderWordsBounce(host: HTMLDivElement, line: LyricLine): void {
    host.replaceChildren();
    const words = line.words ? line.words.map(w => w.text) : line.text.split(/\s+/);
    words.forEach((w, i) => {
      const span = document.createElement("span");
      span.className = "ljay-word ljay-bounce";
      span.style.animationDelay = `${i * 40}ms`;
      span.textContent = w;
      host.appendChild(span);
      host.appendChild(document.createTextNode(" "));
    });
  }

  private applyWordHighlight(line: LyricLine, positionMs: number): void {
    if (this.style.animation === "snippet") {
      this.applySnippetHighlight(positionMs);
      return;
    }
    if (this.style.animation === "karaoke") {
      this.applyKaraokeFill(positionMs);
      return;
    }

    const words = this.currentEl.querySelectorAll<HTMLSpanElement>(".ljay-word");
    if (words.length === 0) return;

    if (line.words && line.words.length === words.length) {
      // Per-word karaoke sweep.
      for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i];
        const nextStart = i + 1 < line.words.length ? line.words[i + 1].startMs : (line.endMs ?? w.startMs + 400);
        const span = words[i];
        if (positionMs >= nextStart) {
          span.style.opacity = "1";
        } else if (positionMs >= w.startMs) {
          const span_dur = Math.max(60, nextStart - w.startMs);
          const t = (positionMs - w.startMs) / span_dur;
          span.style.opacity = String(0.55 + 0.45 * Math.min(1, t));
        } else {
          span.style.opacity = "0.55";
        }
      }
    }
  }

  private applyKaraokeFill(positionMs: number): void {
    const wordEls = this.currentEl.querySelectorAll<HTMLSpanElement>(".ljay-karaoke-word");
    if (wordEls.length === 0) return;
    for (const we of wordEls) {
      const start = Number(we.dataset.start);
      const end = Number(we.dataset.end);
      const fill = we.querySelector<HTMLSpanElement>(".ljay-karaoke-fill");
      if (!fill) continue;
      let pct: number;
      if (positionMs <= start) pct = 0;
      else if (positionMs >= end) pct = 100;
      else pct = ((positionMs - start) / Math.max(40, end - start)) * 100;
      // clip-path: inset(top right bottom left) — we shrink the right side over time.
      fill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    }
  }

  private applySnippetHighlight(positionMs: number): void {
    const spans = this.currentEl.querySelectorAll<HTMLSpanElement>(".ljay-snippet-word");
    if (spans.length === 0) return;

    const window = Math.max(1, this.style.snippetWindow ?? 2);
    const hold = this.hold;

    let currentIdx = -1;
    for (let i = 0; i < spans.length; i++) {
      const start = Number(spans[i].dataset.start);
      if (start <= positionMs) currentIdx = i;
      else break;
    }

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const start = Number(span.dataset.start);
      const end = Number(span.dataset.end);
      const dist = i - currentIdx;
      let opacity = 0;
      let scale = 1;

      if (currentIdx < 0) {
        // Before line begins: show only the first `window` words faintly.
        opacity = i < window ? 0.25 : 0;
      } else if (i === currentIdx) {
        // Current word: bright + tiny pop.
        const dur = Math.max(60, end - start);
        const t = Math.max(0, Math.min(1, (positionMs - start) / dur));
        opacity = 0.85 + 0.15 * t;
        scale = 1.04;
      } else if (dist > 0 && dist <= window) {
        // Upcoming words: dimmer the further out.
        opacity = 0.45 - 0.12 * (dist - 1);
        opacity = Math.max(0.18, opacity);
      } else if (dist < 0) {
        // Already-sung words. In hold mode they all stay visible at a sticky
        // brightness so the singer can see what just passed; otherwise only
        // the in-window trailing words fade out.
        if (hold) {
          opacity = 0.85;
        } else if (-dist <= window) {
          opacity = Math.max(0.15, 0.55 - 0.18 * (-dist - 1));
        } else {
          opacity = 0;
        }
      } else {
        opacity = 0;
      }

      span.style.opacity = String(opacity);
      span.style.transform = scale === 1 ? "" : `scale(${scale})`;
    }
  }

  private cancelTypewriter(): void {
    if (this.typewriterTimer !== null) {
      window.clearInterval(this.typewriterTimer);
      this.typewriterTimer = null;
    }
  }
}

function findLineIndex(lines: LyricLine[], positionMs: number): number {
  // Last line whose startMs <= positionMs.
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return -1;
  const line = lines[ans];
  const end = line.endMs ?? (ans + 1 < lines.length ? lines[ans + 1].startMs : line.startMs + 8000);
  if (positionMs >= end) return -1;
  return ans;
}

function computeTypewriterMs(line: LyricLine): number {
  const dur = (line.endMs ?? line.startMs + 2000) - line.startMs;
  return Math.min(dur / 2, 600);
}

function lineKey(line: LyricLine): string {
  return `${line.startMs}|${line.text}`;
}

interface InferredWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Build per-word timings. Uses real word timing when present; otherwise
 * interpolates linearly across the line's duration. */
function inferWordTimings(line: LyricLine): InferredWord[] {
  const tokens = line.text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const lineEnd = line.endMs ?? line.startMs + Math.max(1500, tokens.length * 220);
  const lineDur = Math.max(200, lineEnd - line.startMs);

  // If real word timings exist and match the token count, use them.
  if (line.words && line.words.length === tokens.length) {
    const out: InferredWord[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const startMs = line.words[i].startMs;
      const endMs = i + 1 < line.words.length ? line.words[i + 1].startMs : lineEnd;
      out.push({ text: tokens[i], startMs, endMs });
    }
    return out;
  }

  // Otherwise interpolate. Weight words by character length so longer words
  // stay on screen a bit longer than short ones.
  const totalChars = tokens.reduce((s, t) => s + Math.max(1, t.length), 0);
  let cursor = line.startMs;
  const out: InferredWord[] = [];
  for (const t of tokens) {
    const share = Math.max(1, t.length) / totalChars;
    const slice = lineDur * share;
    out.push({ text: t, startMs: cursor, endMs: cursor + slice });
    cursor += slice;
  }
  return out;
}

const LYRIC_CSS = `
#lyrics .ljay-line { font-size: clamp(28px, 5.5vw, 84px); line-height: 1.15; max-width: 90vw; }
#lyrics .ljay-line-current { opacity: 1; }
#lyrics .ljay-line-next { font-size: clamp(18px, 3vw, 40px); opacity: 0.45; }
#lyrics .ljay-word { display: inline-block; opacity: 0.55; transition: opacity 80ms linear; }
#lyrics .ljay-snippet-word { display: inline-block; opacity: 0; transition: opacity 140ms ease-out, transform 140ms ease-out; transform-origin: 50% 60%; will-change: opacity, transform; margin: 0 0.18em; }
#lyrics[data-animation="snippet"] .ljay-line-current { font-size: clamp(36px, 7vw, 110px); letter-spacing: 0.01em; line-height: 1.1; }
#lyrics[data-animation="snippet"] .ljay-line-next { display: none; }

/* Subtitle: bottom-anchored single line with dark scrim, broadcast TV style. */
#lyrics[data-animation="subtitle"] { justify-content: flex-end; padding-bottom: 6vh; }
#lyrics[data-animation="subtitle"] .ljay-line-current {
  font-size: clamp(28px, 4.2vw, 64px);
  font-weight: 800;
  letter-spacing: 0;
  line-height: 1.15;
  padding: 0.35em 0.7em;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset;
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  text-shadow: 0 2px 6px rgba(0,0,0,0.85);
  max-width: 84vw;
  white-space: normal;
  text-align: center;
}
#lyrics[data-animation="subtitle"] .ljay-line-next { display: none; }
@keyframes ljay-subtitle-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
#lyrics[data-animation="subtitle"] .ljay-line-current.ljay-enter { animation: ljay-subtitle-in 220ms ease-out both; }

/* Karaoke: whole-line text with a left-to-right colour wipe per word. */
#lyrics[data-animation="karaoke"] .ljay-line-current {
  font-size: clamp(40px, 6.5vw, 96px);
  font-weight: 900;
  letter-spacing: 0.005em;
  line-height: 1.1;
  text-align: center;
  text-shadow: 0 4px 18px rgba(0,0,0,0.85), 0 0 1px rgba(0,0,0,0.6);
}
#lyrics[data-animation="karaoke"] .ljay-line-next { display: none; }
#lyrics .ljay-karaoke-word {
  display: inline-block;
  position: relative;
  margin: 0 0.18em;
}
#lyrics .ljay-karaoke-base {
  color: rgba(255,255,255,0.42);
}
#lyrics .ljay-karaoke-fill {
  position: absolute;
  inset: 0;
  color: #ffe082;
  filter: drop-shadow(0 0 6px rgba(255, 200, 90, 0.7));
  /* clip-path is set inline per frame for the wipe. */
  pointer-events: none;
}
#lyrics[data-animation="scroll"] .ljay-line-current.ljay-enter { animation: ljay-scroll-in 200ms ease-out both; }
#lyrics[data-animation="fade"] .ljay-line-current.ljay-fade-in { animation: ljay-fade 250ms ease-out both; }
#lyrics[data-animation="fade"] .ljay-line-next { display: none; }
#lyrics[data-animation="bounce"] .ljay-word.ljay-bounce { animation: ljay-bounce 380ms cubic-bezier(.2,.8,.2,1.2) both; opacity: 1; }
@keyframes ljay-scroll-in { from { transform: translateY(18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes ljay-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ljay-bounce { 0% { transform: translateY(14px); opacity: 0; } 60% { transform: translateY(-3px); opacity: 1; } 100% { transform: translateY(0); } }
`;
