import type { Lyrics, LyricLine, LyricsResolver, NowPlaying } from "../types";
import { LyricsCache } from "./cache";

type Listener = (l: Lyrics | null) => void;

export class LyricsStore {
  private resolver: LyricsResolver;
  private cache: LyricsCache;
  private lyrics: Lyrics | null = null;
  private listeners = new Set<Listener>();
  private cursor = 0;
  private inflightKey: string | null = null;

  constructor(resolver: LyricsResolver, cache: LyricsCache) {
    this.resolver = resolver;
    this.cache = cache;
  }

  async loadFor(track: NowPlaying): Promise<Lyrics | null> {
    const cached = this.cache.get(track);
    if (cached) {
      this.setLyrics(cached);
      return cached;
    }

    const key = `${track.title}|${track.artist}|${track.album ?? ""}|${track.durationMs}`;
    if (this.inflightKey === key) return this.lyrics;
    this.inflightKey = key;

    let result: Lyrics | null = null;
    try {
      result = await this.resolver.resolve(track);
    } catch (e) {
      console.warn("[lyrics-store] resolver threw", e);
      result = null;
    }
    if (this.inflightKey !== key) return this.lyrics;
    this.inflightKey = null;

    if (result) this.cache.set(track, result);
    this.setLyrics(result);
    return result;
  }

  private setLyrics(l: Lyrics | null): void {
    this.lyrics = l;
    this.cursor = 0;
    for (const fn of this.listeners) {
      try { fn(l); } catch (e) { console.warn("[lyrics-store] listener threw", e); }
    }
  }

  currentLyrics(): Lyrics | null {
    return this.lyrics;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  clear(): void {
    this.inflightKey = null;
    this.setLyrics(null);
  }

  lineAt(positionMs: number): { current: LyricLine | null; next: LyricLine | null; index: number } {
    const lines = this.lyrics?.lines;
    if (!lines || lines.length === 0) return { current: null, next: null, index: -1 };

    let idx = this.cursor;
    if (idx < 0 || idx >= lines.length) idx = 0;

    const atOrBefore = (i: number) => i >= 0 && i < lines.length && lines[i].startMs <= positionMs;
    const after = (i: number) => i + 1 >= lines.length || lines[i + 1].startMs > positionMs;

    if (atOrBefore(idx) && after(idx)) {
      this.cursor = idx;
    } else if (idx + 1 < lines.length && lines[idx + 1].startMs <= positionMs &&
               (idx + 2 >= lines.length || lines[idx + 2].startMs > positionMs)) {
      idx = idx + 1;
      this.cursor = idx;
    } else {
      idx = bsearchStart(lines, positionMs);
      this.cursor = idx >= 0 ? idx : 0;
    }

    if (idx < 0) {
      return { current: null, next: lines[0] ?? null, index: -1 };
    }
    return {
      current: lines[idx] ?? null,
      next: lines[idx + 1] ?? null,
      index: idx,
    };
  }
}

function bsearchStart(lines: LyricLine[], positionMs: number): number {
  if (lines.length === 0) return -1;
  if (positionMs < lines[0].startMs) return -1;
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
  return ans;
}
