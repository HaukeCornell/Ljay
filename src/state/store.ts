import type { AppState } from "../types";

type Listener = (s: AppState) => void;

const initial: AppState = {
  source: "offline",
  nowPlaying: null,
  playhead: null,
  lyrics: null,
  currentVibe: "winamp",
  lyricsVisible: true,
};

let state: AppState = initial;
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}
