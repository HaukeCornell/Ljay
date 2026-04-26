import type { LyricLine, LyricStyle } from "../types";

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
  private visible = true;
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
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.host.style.display = v ? "" : "none";
  }

  update(positionMs: number, lines: LyricLine[] | null): void {
    if (!this.visible || this.disposed) return;

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
    this.host.replaceChildren();
  }

  // -------- internals --------

  private applyStyle(): void {
    const s = this.style;
    const transform = s.uppercase ? "uppercase" : "none";
    for (const el of [this.currentEl, this.nextEl]) {
      el.style.fontFamily = s.font;
      el.style.fontWeight = String(s.weight);
      el.style.color = s.color;
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
    }
  }

  private hardCut(line: LyricLine, next: LyricLine | null, animation: Animation): void {
    if (animation === "typewriter") {
      this.currentEl.textContent = line.text;
    } else {
      this.renderWords(this.currentEl, line);
    }
    this.nextEl.textContent = animation === "fade" ? "" : (next?.text ?? "");
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

const LYRIC_CSS = `
#lyrics .ljay-line { font-size: clamp(28px, 5.5vw, 84px); line-height: 1.15; max-width: 90vw; }
#lyrics .ljay-line-current { opacity: 1; }
#lyrics .ljay-line-next { font-size: clamp(18px, 3vw, 40px); opacity: 0.45; }
#lyrics .ljay-word { display: inline-block; opacity: 0.55; transition: opacity 80ms linear; }
#lyrics[data-animation="scroll"] .ljay-line-current.ljay-enter { animation: ljay-scroll-in 200ms ease-out both; }
#lyrics[data-animation="fade"] .ljay-line-current.ljay-fade-in { animation: ljay-fade 250ms ease-out both; }
#lyrics[data-animation="fade"] .ljay-line-next { display: none; }
#lyrics[data-animation="bounce"] .ljay-word.ljay-bounce { animation: ljay-bounce 380ms cubic-bezier(.2,.8,.2,1.2) both; opacity: 1; }
@keyframes ljay-scroll-in { from { transform: translateY(18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes ljay-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ljay-bounce { 0% { transform: translateY(14px); opacity: 0; } 60% { transform: translateY(-3px); opacity: 1; } 100% { transform: translateY(0); } }
`;
