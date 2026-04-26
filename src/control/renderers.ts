// 2D-canvas preview renderers — one per effect/lyric/video. Each renderer is a
// factory: given a `params` object it returns a per-frame `(ctx, audio, dt, w,
// h) => void` closure. Ported verbatim from the design's state.jsx.
//
// The previews intentionally hint at the look of each layer — they aren't the
// real Ljay vibe renderers (those live under src/vibes/ and run on the public
// monitor). Keep these cheap.

import type { PreviewAudioFrame, PreviewRenderFn } from "./tick";

export interface RendererParams {
  color: string;
  accent: string;
  reactivity: number;
  // The customize popup may write extra fields we don't read here — keep
  // the signature loose without leaking `any` everywhere.
  [key: string]: unknown;
}

export type RendererFactory = (params: RendererParams) => PreviewRenderFn;

/** Module-level mutable state for renderers that need persistent particles. */
interface RendererCache {
  starfield?: { x: number; y: number; z: number }[];
  planetStars?: { x: number; y: number; s: number }[];
  lyricParticles?: { x: number; y: number; tx: number; ty: number; vx: number; vy: number }[];
}
const cache: RendererCache = {};

const renderers: Record<string, RendererFactory> = {};

renderers.starfield = (params) => (ctx, audio, dt, w, h) => {
  if (!cache.starfield) {
    cache.starfield = Array.from({ length: 80 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 1 + 0.2,
    }));
  }
  ctx.fillStyle = params.accent || "#000";
  ctx.fillRect(0, 0, w, h);
  for (const s of cache.starfield) {
    s.x -= s.z * (60 + audio.bass * 100) * dt;
    if (s.x < 0) {
      s.x = w;
      s.y = Math.random() * h;
    }
    ctx.fillStyle = params.color;
    ctx.globalAlpha = s.z;
    ctx.fillRect(s.x, s.y, s.z * 2, 1);
  }
  ctx.globalAlpha = 1;
};

renderers.tron = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#000";
  ctx.fillRect(0, 0, w, h);
  const t = audio.t;
  const horizon = h * 0.55;
  const grad = ctx.createLinearGradient(0, 0, 0, horizon);
  grad.addColorStop(0, "#000");
  grad.addColorStop(1, params.color + "20");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, horizon);
  ctx.strokeStyle = params.color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6 + audio.beat * 0.4 * (params.reactivity || 1);
  for (let i = 0; i < 12; i++) {
    const tt = (t * 0.5 + i / 12) % 1;
    const yy = horizon + tt * tt * (h - horizon);
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w, yy);
    ctx.stroke();
  }
  for (let i = -8; i <= 8; i++) {
    const xTop = w / 2 + i * 16;
    const xBot = w / 2 + i * 80;
    ctx.beginPath();
    ctx.moveTo(xTop, horizon);
    ctx.lineTo(xBot, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

renderers.tunnel = (params) => (ctx, audio, _dt, w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const t = audio.t;
  const rings = 18;
  for (let i = rings; i > 0; i--) {
    const tt = i / rings + ((t * 0.4) % (1 / rings));
    const r = tt * Math.min(w, h) * 0.7;
    const c1 = params.color;
    const c2 = params.accent;
    ctx.strokeStyle = i % 2 === 0 ? c1 : c2;
    ctx.lineWidth = 6 - tt * 5;
    ctx.globalAlpha = (1 - tt) * (0.6 + audio.beat * 0.4 * (params.reactivity || 1));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

renderers.halftone = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#f3ead4";
  ctx.fillRect(0, 0, w, h);
  const cell = 10;
  const t = audio.t;
  ctx.fillStyle = params.color;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const nx = (x / w - 0.5) * 2;
      const ny = (y / h - 0.5) * 2;
      const d = Math.sqrt(nx * nx + ny * ny);
      const wave = 0.5 + 0.5 * Math.sin(d * 8 - t * 3);
      const r = wave * (cell / 2 - 1) * (0.6 + audio.bass * 0.6 * (params.reactivity || 1));
      ctx.beginPath();
      ctx.arc(x + cell / 2, y + cell / 2, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

renderers.lensflare = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const cx = w * (0.5 + Math.sin(audio.t * 0.3) * 0.2);
  const cy = h * 0.5;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 80);
  core.addColorStop(0, params.color);
  core.addColorStop(0.3, params.accent + "cc");
  core.addColorStop(1, "#00000000");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    const t = i / 6 - 0.5;
    const gx = cx + (cx - w / 2) * t * 2;
    const gy = cy + (cy - h / 2) * t * 2;
    const r = 8 + i * 4 + audio.beat * 10 * (params.reactivity || 1);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, params.accent + "80");
    g.addColorStop(1, "#00000000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.strokeStyle = params.color + "30";
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + audio.t * 0.1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * 200, cy + Math.sin(a) * 200);
    ctx.stroke();
  }
};

renderers.planet = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, w, h);
  if (!cache.planetStars) {
    cache.planetStars = Array.from({ length: 60 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      s: Math.random(),
    }));
  }
  ctx.fillStyle = "#fff";
  for (const s of cache.planetStars) {
    ctx.globalAlpha = s.s * 0.8;
    ctx.fillRect(s.x, s.y, 1, 1);
  }
  ctx.globalAlpha = 1;
  const cx = w / 2;
  const cy = h / 2 + 10;
  const r = 50 + audio.bass * 8 * (params.reactivity || 1);
  const g = ctx.createRadialGradient(cx - 15, cy - 15, 5, cx, cy, r);
  g.addColorStop(0, params.accent);
  g.addColorStop(0.7, params.color);
  g.addColorStop(1, "#000");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = params.color + "90";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.stroke();
};

renderers.fft = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#0a4030";
  ctx.fillRect(0, 0, w, h);
  const N = 32;
  const bw = w / N - 1;
  for (let i = 0; i < N; i++) {
    const f = i / N;
    const v = (f < 0.3 ? audio.bass : f < 0.6 ? audio.mid : audio.treble) * (1 - f * 0.3);
    const bh = v * h * 0.85 * (params.reactivity || 1);
    ctx.fillStyle = params.color;
    ctx.fillRect(i * (bw + 1), h - bh, bw, bh);
    ctx.globalAlpha = 0.3;
    ctx.fillRect(i * (bw + 1), 0, bw, bh * 0.5);
    ctx.globalAlpha = 1;
  }
};

renderers.perlin = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#1f2030";
  ctx.fillRect(0, 0, w, h);
  const t = audio.t * 0.3;
  for (let i = 0; i < 6; i++) {
    const x = w / 2 + Math.sin(t + i) * w * 0.4;
    const y = h / 2 + Math.cos(t * 0.7 + i * 1.3) * h * 0.4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 80 + audio.mid * 50 * (params.reactivity || 1));
    g.addColorStop(0, params.color + "80");
    g.addColorStop(1, "#00000000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
};

renderers.minimal = (params) => (ctx, audio, _dt, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, params.color);
  g.addColorStop(1, params.accent);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
  ctx.fillStyle = `rgba(255,255,255,${audio.beat * 0.2 * (params.reactivity || 1)})`;
  ctx.fillRect(0, h * 0.5 - 1, w, 2);
};

// ─── Lyric renderers ───

renderers.lyric_spatial = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#08080c";
  ctx.fillRect(0, 0, w, h);
  const text = "NIGHT";
  const cx = w / 2;
  const cy = h / 2;
  const punch = 1 + audio.beat * 0.15 * (params.reactivity || 1);
  ctx.font = `bold ${Math.floor(48 * punch)}px Inter Tight`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 6; i > 0; i--) {
    ctx.fillStyle = params.accent + Math.floor(80 - i * 10).toString(16).padStart(2, "0");
    ctx.fillText(text, cx + i, cy + i);
  }
  ctx.fillStyle = params.color;
  ctx.fillText(text, cx, cy);
};

renderers.lyric_particles = (params) => (ctx, audio, dt, w, h) => {
  if (!cache.lyricParticles) {
    cache.lyricParticles = Array.from({ length: 200 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      tx: Math.random() * w,
      ty: Math.random() * h,
      vx: 0,
      vy: 0,
    }));
  }
  ctx.fillStyle = "rgba(8,8,12,0.25)";
  ctx.fillRect(0, 0, w, h);
  const t = audio.t;
  const period = 4;
  const phase = (t % period) / period;
  ctx.font = "bold 56px Inter Tight";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = phase < 0.7 ? "NIGHT" : "CITY";
  ctx.fillStyle = params.color + "20";
  ctx.fillText(text, w / 2, h / 2);
  for (const p of cache.lyricParticles) {
    if (Math.random() < 0.02) {
      p.tx = w / 2 + (Math.random() - 0.5) * 160;
      p.ty = h / 2 + (Math.random() - 0.5) * 50;
    }
    p.vx += (p.tx - p.x) * 0.05;
    p.vy += (p.ty - p.y) * 0.05;
    p.vx *= 0.85;
    p.vy *= 0.85;
    p.x += p.vx * dt * 10;
    p.y += p.vy * dt * 10;
    ctx.fillStyle = Math.random() < 0.5 ? params.color : params.accent;
    ctx.globalAlpha = 0.7 + audio.beat * 0.3 * (params.reactivity || 1);
    ctx.fillRect(p.x, p.y, 2, 2);
  }
  ctx.globalAlpha = 1;
};

renderers.lyric_karaoke = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, w, h);
  const text = "NIGHT CITY";
  ctx.font = "bold 36px Inter Tight";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = params.accent;
  ctx.fillText(text, w / 2, h / 2);
  const t = audio.t * 0.5;
  const p = t % 1;
  ctx.save();
  ctx.beginPath();
  const m = ctx.measureText(text);
  ctx.rect(w / 2 - m.width / 2, h / 2 - 30, m.width * p, 60);
  ctx.clip();
  ctx.fillStyle = params.color;
  ctx.fillText(text, w / 2, h / 2);
  ctx.restore();
};

renderers.lyric_subtitle = (params) => (ctx, _audio, _dt, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#1a1f30");
  g.addColorStop(1, "#0a0a14");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = params.accent + "aa";
  ctx.fillRect(0, h - 50, w, 36);
  ctx.font = "14px Inter Tight";
  ctx.fillStyle = params.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Waiting in a car, waiting for a ride", w / 2, h - 32);
};

renderers.lyric_snippet = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "bold 22px Inter Tight";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = ["waiting", "in", "a", "car"];
  const t = Math.floor(audio.t) % words.length;
  for (let i = -1; i <= 1; i++) {
    const idx = (t + i + words.length) % words.length;
    ctx.fillStyle = i === 0 ? params.color : params.accent + "50";
    ctx.fillText(words[idx], w / 2 + i * 80, h / 2);
  }
};

renderers.lyric_scroll = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "bold 20px Inter Tight";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = params.color;
  const text = "Waiting for a ride in the dark · ";
  const x = -((audio.t * 60) % 300);
  ctx.fillText(text + text, x, h / 2);
};

renderers.lyric_fade = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#000";
  ctx.fillRect(0, 0, w, h);
  const t = audio.t;
  const fade = Math.abs(Math.sin(t * 0.7));
  ctx.font = "bold 30px Inter Tight";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = params.color;
  ctx.globalAlpha = fade;
  ctx.fillText("NIGHT CITY", w / 2, h / 2);
  ctx.globalAlpha = 1;
};

renderers.lyric_typewriter = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#000";
  ctx.fillRect(0, 0, w, h);
  const text = "NIGHT CITY";
  const period = 3;
  const phase = (audio.t % period) / period;
  const n = Math.floor(phase * (text.length + 2));
  ctx.font = "bold 26px JetBrains Mono";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = params.color;
  const showText =
    text.slice(0, Math.min(text.length, n)) +
    (Math.floor(audio.t * 3) % 2 ? "_" : " ");
  ctx.fillText(showText, w / 2, h / 2);
};

renderers.lyric_bounce = (params) => (ctx, audio, _dt, w, h) => {
  ctx.fillStyle = params.accent || "#0a0a14";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "bold 30px Inter Tight";
  ctx.textBaseline = "middle";
  ctx.fillStyle = params.color;
  const text = "NIGHTCITY";
  let x = w / 2 - 110;
  for (let i = 0; i < text.length; i++) {
    const phase = (audio.t * 2 + i * 0.2) % (Math.PI * 2);
    const dy = Math.max(0, Math.sin(phase)) * 14 * (params.reactivity || 1);
    ctx.fillText(text[i], x, h / 2 - dy);
    x += 24;
  }
};

// ─── Video preview (fake) ───
renderers.video = (_params) => (ctx, audio, _dt, w, h) => {
  const t = audio.t;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#3a1e6a");
  g.addColorStop(0.5, "#ff5ea8");
  g.addColorStop(1, "#ff9344");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#0a0612";
  for (let i = 0; i < 20; i++) {
    const bw = 10 + ((i * 13) % 18);
    const bh = 30 + (Math.sin(i * 1.7) * 0.5 + 0.5) * 80;
    ctx.fillRect(i * (w / 20) + ((t * 20) % 30) - 30, h - bh, bw, bh);
  }
  ctx.fillStyle = "#ffd6a8";
  ctx.beginPath();
  ctx.arc(w * 0.7, h * 0.3, 14, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
};

export const Renderers: Record<string, RendererFactory> = renderers;

/** Fallback renderer used when an effect/lyric id has no matching factory. */
export function fallbackRenderer(): PreviewRenderFn {
  return (ctx, _a, _dt, w, h) => {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, h);
  };
}

// Re-export for convenience.
export type { PreviewAudioFrame, PreviewRenderFn };
