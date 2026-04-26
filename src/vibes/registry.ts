import type { Vibe } from "../types.ts";

// Music video is no longer a vibe — it's a separate Video toggle layer that
// composites on top of whatever vibe is selected (see src/ui/videoLayer.ts).
export const vibes: Record<string, () => Promise<Vibe>> = {
  flythrough: async () => (await import("./flythrough.ts")).create(),
  planet:     async () => (await import("./planet.ts")).create(),
  winamp:     async () => (await import("./winamp.ts")).create(),
  tunnel:     async () => (await import("./tunnel.ts")).create(),
  minimal:    async () => (await import("./minimal.ts")).create(),
};

const META: { id: string; name: string }[] = [
  { id: "auto",       name: "Auto (cycle per track)" },
  { id: "flythrough", name: "Fly-through" },
  { id: "planet",     name: "Planet" },
  { id: "winamp",     name: "Winamp" },
  { id: "tunnel",     name: "Tunnel" },
  { id: "minimal",    name: "Minimal" },
];

export const AUTO_CYCLE_IDS = ["flythrough", "planet", "winamp", "tunnel", "minimal"];

export function listVibes(): { id: string; name: string }[] {
  return META.slice();
}
