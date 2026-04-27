// Effect + lyric catalogs ported from the design's state.jsx.
//
// The design lists effects (`starfield`, `tron`, `fft`, `perlin`) we don't yet
// have as Ljay vibes. We keep the full catalog so the panel UI matches the
// design pixel-for-pixel; cards without a `ljayVibeId` are visual-only —
// tapping them is a no-op (see Panel.tsx).

export interface EffectParamsDefaults {
  color: string;
  accent: string;
  reactivity: number;
}

export interface EffectCatalogEntry {
  id: string;
  name: string;
  kind: "effect";
  defaults: EffectParamsDefaults;
  /** Maps to a real Ljay vibe id. `null` means preview-only (no-op on tap). */
  ljayVibeId: string | null;
}

export interface LyricCatalogEntry {
  id: string;
  name: string;
  defaults: EffectParamsDefaults;
  /** Whether the "Hold already-sung words" toggle has any effect on this style. */
  supportsHold: boolean;
}

export const EFFECTS: EffectCatalogEntry[] = [
  { id: "starfield",  name: "Starfield",    kind: "effect", defaults: { color: "#b8d8ff", accent: "#ffffff", reactivity: 0.6  }, ljayVibeId: "starfield"  },
  { id: "tron",       name: "Tron Grid",    kind: "effect", defaults: { color: "#7cffb2", accent: "#0a1a14", reactivity: 0.7  }, ljayVibeId: "tron"       },
  { id: "tunnel",     name: "Tunnel",       kind: "effect", defaults: { color: "#ff5ea8", accent: "#5b8cff", reactivity: 0.8  }, ljayVibeId: "tunnel"     },
  { id: "halftone",   name: "Halftone",     kind: "effect", defaults: { color: "#0a0a0a", accent: "#f3ead4", reactivity: 0.85 }, ljayVibeId: "halftone"   },
  { id: "lensflare",  name: "Lens Flare",   kind: "effect", defaults: { color: "#fff0c4", accent: "#ff7a00", reactivity: 1.0  }, ljayVibeId: "lensflare"  },
  { id: "planet",     name: "Planet",       kind: "effect", defaults: { color: "#5b8cff", accent: "#ffd6a8", reactivity: 0.5  }, ljayVibeId: "planet"     },
  { id: "fft",        name: "FFT Bars",     kind: "effect", defaults: { color: "#7cffb2", accent: "#0a4030", reactivity: 1.0  }, ljayVibeId: "fft"        },
  { id: "perlin",     name: "Perlin Field", kind: "effect", defaults: { color: "#5b8cff", accent: "#1f2030", reactivity: 0.6  }, ljayVibeId: "perlin"     },
  { id: "minimal",    name: "Minimal",      kind: "effect", defaults: { color: "#3a4050", accent: "#e6e7e8", reactivity: 0.3  }, ljayVibeId: "minimal"    },
  { id: "winamp",     name: "Winamp",       kind: "effect", defaults: { color: "#7cffb2", accent: "#000000", reactivity: 0.9  }, ljayVibeId: "winamp"     },
  { id: "flythrough", name: "Fly-through",  kind: "effect", defaults: { color: "#ffffff", accent: "#5b8cff", reactivity: 0.7  }, ljayVibeId: "flythrough" },
];

// Hold semantics: when on, already-sung text stays prominent.
// - spatial:   words past their sing-window keep their `active` glow instead of fading
// - particles: when no word is active, particles stay locked on the last word
// - snippet:   already-sung words in the line keep at sticky brightness
// Single-line modes (karaoke / subtitle / scroll / fade / typewriter / bounce)
// only ever show one line at a time, so hold has nothing to preserve.
export const LYRIC_STYLES: LyricCatalogEntry[] = [
  { id: "spatial",    name: "Spatial 3D",  supportsHold: true,  defaults: { color: "#ffffff", accent: "#7cffb2", reactivity: 0.8 } },
  { id: "particles",  name: "Particles",   supportsHold: true,  defaults: { color: "#ffd6a8", accent: "#b8d8ff", reactivity: 1.0 } },
  { id: "karaoke",    name: "Karaoke",     supportsHold: false, defaults: { color: "#ffd84a", accent: "#ffffff", reactivity: 0.4 } },
  { id: "subtitle",   name: "Subtitle",    supportsHold: false, defaults: { color: "#ffffff", accent: "#000000", reactivity: 0.2 } },
  { id: "snippet",    name: "Snippet",     supportsHold: true,  defaults: { color: "#ffffff", accent: "#7cffb2", reactivity: 0.4 } },
  { id: "scroll",     name: "Scroll",      supportsHold: false, defaults: { color: "#ffffff", accent: "#5b8cff", reactivity: 0.3 } },
  { id: "fade",       name: "Fade",        supportsHold: false, defaults: { color: "#ffffff", accent: "#000000", reactivity: 0.2 } },
  { id: "typewriter", name: "Typewriter",  supportsHold: false, defaults: { color: "#7cffb2", accent: "#000000", reactivity: 0.3 } },
  { id: "bounce",     name: "Bounce",      supportsHold: false, defaults: { color: "#ff5ea8", accent: "#ffffff", reactivity: 0.7 } },
];

/** True iff the named lyric style honors the Hold toggle. */
export function lyricSupportsHold(id: string): boolean {
  return LYRIC_STYLES.find((s) => s.id === id)?.supportsHold ?? false;
}
