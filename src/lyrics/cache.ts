import type { Lyrics, NowPlaying } from "../types";

const PREFIX = "ljay:lyrics:";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function makeTrackKey(track: NowPlaying): string {
  const title = (track.title ?? "").toLowerCase().trim();
  const artist = (track.artist ?? "").toLowerCase().trim();
  return `${title}|${artist}`;
}

interface Wrapper {
  fetchedAt: number;
  lyrics: Lyrics;
}

export class LyricsCache {
  private storage: Storage | null;

  constructor(storage?: Storage) {
    if (storage) {
      this.storage = storage;
    } else if (typeof localStorage !== "undefined") {
      this.storage = localStorage;
    } else {
      this.storage = null;
    }
  }

  private storageKey(track: NowPlaying): string {
    return `${PREFIX}${makeTrackKey(track)}`;
  }

  get(track: NowPlaying): Lyrics | null {
    if (!this.storage) return null;
    const k = this.storageKey(track);
    const raw = this.storage.getItem(k);
    if (!raw) return null;
    try {
      const wrap = JSON.parse(raw) as Wrapper;
      if (!wrap || typeof wrap.fetchedAt !== "number" || !wrap.lyrics) {
        this.storage.removeItem(k);
        return null;
      }
      if (Date.now() - wrap.fetchedAt > TTL_MS) {
        this.storage.removeItem(k);
        return null;
      }
      return wrap.lyrics;
    } catch {
      this.storage.removeItem(k);
      return null;
    }
  }

  set(track: NowPlaying, lyrics: Lyrics): void {
    if (!this.storage) return;
    const wrap: Wrapper = { fetchedAt: Date.now(), lyrics };
    try {
      this.storage.setItem(this.storageKey(track), JSON.stringify(wrap));
    } catch (e) {
      console.warn("[lyrics-cache] set failed", e);
    }
  }

  has(track: NowPlaying): boolean {
    return this.get(track) !== null;
  }
}
