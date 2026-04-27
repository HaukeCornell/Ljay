import type { Vibe } from "../types.ts";

// Music video is no longer a vibe — it's a separate Video toggle layer that
// composites on top of whatever vibe is selected (see src/ui/videoLayer.ts).
export const vibes: Record<string, () => Promise<Vibe>> = {
  flythrough: async () => (await import("./flythrough.ts")).create(),
  planet:     async () => (await import("./planet.ts")).create(),
  winamp:     async () => (await import("./winamp.ts")).create(),
  tunnel:     async () => (await import("./tunnel.ts")).create(),
  minimal:    async () => (await import("./minimal.ts")).create(),
  starfield:  async () => (await import("./starfield.ts")).create(),
  tron:       async () => (await import("./tron.ts")).create(),
  fft:        async () => (await import("./fft.ts")).create(),
  perlin:     async () => (await import("./perlin.ts")).create(),
  lensflare:  async () => (await import("./lensflare.ts")).create(),
  halftone:   async () => (await import("./halftone.ts")).create(),
};

const META: { id: string; name: string }[] = [
  { id: "auto",       name: "Auto (cycle per track)" },
  { id: "flythrough", name: "Fly-through" },
  { id: "planet",     name: "Planet" },
  { id: "winamp",     name: "Winamp" },
  { id: "tunnel",     name: "Tunnel" },
  { id: "minimal",    name: "Minimal" },
  { id: "starfield",  name: "Starfield" },
  { id: "tron",       name: "Tron Grid" },
  { id: "fft",        name: "FFT Bars" },
  { id: "perlin",     name: "Perlin Field" },
  { id: "lensflare",  name: "Lens flare" },
  { id: "halftone",   name: "Halftone" },
];

export const AUTO_CYCLE_IDS = [
  "flythrough", "planet", "winamp", "tunnel", "minimal",
  "starfield", "tron", "fft", "perlin",
  "lensflare", "halftone",
];

export function listVibes(): { id: string; name: string }[] {
  return META.slice();
}
