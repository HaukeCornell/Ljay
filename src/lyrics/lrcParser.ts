import type { LyricLine } from "../types";

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const METADATA_RE = /^\[([a-zA-Z]+):\s*(.*?)\]\s*$/;
const WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function toMs(min: string, sec: string, frac: string | undefined): number {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  let f = 0;
  if (frac !== undefined) {
    const padded = (frac + "000").slice(0, 3);
    f = parseInt(padded, 10);
  }
  return m * 60_000 + s * 1000 + f;
}

interface RawLine {
  startMs: number;
  text: string;
  words?: { startMs: number; text: string }[];
}

function parseEnhancedText(rawText: string, lineStartMs: number, lineEndHintMs: number | null):
  { text: string; words?: { startMs: number; text: string }[] } {
  if (!rawText.includes("<")) return { text: rawText.trim() };

  const words: { startMs: number; text: string }[] = [];
  let plain = "";
  let lastIndex = 0;
  let pendingTime: number | null = null;
  let pendingBuffer = "";
  WORD_TAG_RE.lastIndex = 0;

  const flushPending = () => {
    if (pendingTime !== null) {
      const trimmed = pendingBuffer.replace(/^\s+|\s+$/g, "");
      if (trimmed.length > 0) {
        words.push({ startMs: pendingTime, text: trimmed });
      }
    }
    pendingBuffer = "";
  };

  let match: RegExpExecArray | null;
  while ((match = WORD_TAG_RE.exec(rawText)) !== null) {
    const between = rawText.slice(lastIndex, match.index);
    plain += between;
    pendingBuffer += between;
    flushPending();
    pendingTime = toMs(match[1], match[2], match[3]);
    if (lineEndHintMs !== null && pendingTime > lineEndHintMs) pendingTime = lineEndHintMs;
    if (pendingTime < lineStartMs) pendingTime = lineStartMs;
    lastIndex = match.index + match[0].length;
  }
  const tail = rawText.slice(lastIndex);
  plain += tail;
  pendingBuffer += tail;
  flushPending();

  const cleanText = plain.trim();
  return words.length > 0 ? { text: cleanText, words } : { text: cleanText };
}

export function parseLrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  let offsetMs = 0;
  const raw: RawLine[] = [];

  for (const original of lines) {
    const line = original.replace(/^﻿/, "");
    if (line.trim().length === 0) continue;

    const meta = line.match(METADATA_RE);
    if (meta && !/^\d+$/.test(meta[1])) {
      const tag = meta[1].toLowerCase();
      if (tag === "offset") {
        const v = parseInt(meta[2].trim(), 10);
        if (!Number.isNaN(v)) offsetMs = v;
        continue;
      }
      if (tag === "ti" || tag === "ar" || tag === "al" || tag === "au" ||
          tag === "length" || tag === "by" || tag === "re" || tag === "ve" ||
          tag === "lang" || tag === "tool") {
        continue;
      }
    }

    TIMESTAMP_RE.lastIndex = 0;
    const stamps: number[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = TIMESTAMP_RE.exec(line)) !== null) {
      if (m.index !== lastEnd) {
        const skipped = line.slice(lastEnd, m.index);
        if (skipped.trim().length > 0) break;
      }
      stamps.push(toMs(m[1], m[2], m[3]));
      lastEnd = m.index + m[0].length;
    }
    if (stamps.length === 0) continue;

    const rest = line.slice(lastEnd);
    for (const s of stamps) {
      raw.push({ startMs: s, text: rest });
    }
  }

  raw.sort((a, b) => a.startMs - b.startMs);

  const out: LyricLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const startMs = Math.max(0, r.startMs + offsetMs);
    const nextStart = i + 1 < raw.length ? Math.max(0, raw[i + 1].startMs + offsetMs) : undefined;
    const enhanced = parseEnhancedText(r.text, startMs, nextStart ?? null);
    const line: LyricLine = { startMs, text: enhanced.text };
    if (nextStart !== undefined) line.endMs = nextStart;
    if (enhanced.words && enhanced.words.length > 0) line.words = enhanced.words;
    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1].text.trim().length === 0) {
    out.pop();
    if (out.length > 0) delete out[out.length - 1].endMs;
  }
  for (let i = 0; i < out.length - 1; i++) {
    out[i].endMs = out[i + 1].startMs;
  }

  return out;
}
