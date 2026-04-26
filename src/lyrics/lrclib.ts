import type { LyricsResolver, NowPlaying, Lyrics, LyricLine } from "../types";
import { parseLrc } from "./lrcParser";
import { makeTrackKey } from "./cache";

// Browsers strip User-Agent, and LRCLIB asks for identification.
// In dev/prod we proxy through our own server (Vite dev proxy or sidecar)
// which injects the UA header server-side.
const BASE = "/lrclib";
const DURATION_TOLERANCE_S = 5;

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function norm(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

function fakeTimingForPlain(text: string, durationMs: number): LyricLine[] {
  const rows = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  if (rows.length === 0) return [];
  const span = Math.max(durationMs, rows.length * 1500);
  const step = span / rows.length;
  const out: LyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const startMs = Math.round(i * step);
    const endMs = Math.round((i + 1) * step);
    out.push({ startMs, endMs, text: rows[i] });
  }
  return out;
}

function recordToLyrics(rec: LrclibRecord, track: NowPlaying): Lyrics | null {
  const key = makeTrackKey(track);
  if (rec.syncedLyrics && rec.syncedLyrics.trim().length > 0) {
    const lines = parseLrc(rec.syncedLyrics);
    if (lines.length === 0) return null;
    return { trackKey: key, source: "lrclib", lines, synced: true };
  }
  if (rec.plainLyrics && rec.plainLyrics.trim().length > 0) {
    const lines = fakeTimingForPlain(rec.plainLyrics, track.durationMs);
    if (lines.length === 0) return null;
    return { trackKey: key, source: "lrclib", lines, synced: false };
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[lrclib] ${res.status} ${res.statusText} for ${url}`);
      return null;
    }
    return await res.json() as T;
  } catch (e) {
    console.warn("[lrclib] network error", e);
    return null;
  }
}

export class LrclibResolver implements LyricsResolver {
  async resolve(track: NowPlaying): Promise<Lyrics | null> {
    if (!track.title || track.title.trim().length === 0) return null;
    const artist = track.artist ?? "";
    const durationS = Math.round(track.durationMs / 1000);

    const params = new URLSearchParams();
    params.set("track_name", track.title);
    params.set("artist_name", artist);
    if (track.album) params.set("album_name", track.album);
    if (durationS > 0) params.set("duration", String(durationS));

    const exact = await fetchJson<LrclibRecord>(`${BASE}/api/get?${params.toString()}`);
    if (exact) {
      const lyr = recordToLyrics(exact, track);
      if (lyr) return lyr;
    }

    const q = `${track.title} ${artist}`.trim();
    const searchParams = new URLSearchParams();
    searchParams.set("q", q);
    const list = await fetchJson<LrclibRecord[]>(`${BASE}/api/search?${searchParams.toString()}`);
    if (!list || list.length === 0) return null;

    const wantTitle = norm(track.title);
    const wantArtist = norm(artist);
    const wantCombined = `${wantArtist} ${wantTitle}`.trim();

    let best: { rec: LrclibRecord; score: number } | null = null;
    for (const rec of list) {
      const haveCombined = `${norm(rec.artistName)} ${norm(rec.trackName)}`.trim();
      const dist = levenshtein(wantCombined, haveCombined);
      const denom = Math.max(wantCombined.length, haveCombined.length, 1);
      const fuzz = 1 - dist / denom;
      const recDur = rec.duration ?? 0;
      const dDur = durationS > 0 ? Math.abs(recDur - durationS) : 0;
      const durBonus = durationS > 0
        ? (dDur <= DURATION_TOLERANCE_S ? 0.25 : Math.max(0, 0.25 - dDur / 60))
        : 0;
      const hasSynced = rec.syncedLyrics && rec.syncedLyrics.trim().length > 0 ? 0.1 : 0;
      const score = fuzz + durBonus + hasSynced;
      if (!best || score > best.score) best = { rec, score };
    }
    if (!best) return null;
    return recordToLyrics(best.rec, track);
  }
}
