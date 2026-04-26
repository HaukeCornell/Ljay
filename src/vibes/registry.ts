import type { Vibe } from "../types.ts";

export const vibes: Record<string, () => Promise<Vibe>> = {
  flythrough: async () => (await import("./flythrough.ts")).create(),
  mv:         async () => (await import("./mv.ts")).create(),
  planet:     async () => (await import("./planet.ts")).create(),
  winamp:     async () => (await import("./winamp.ts")).create(),
  tunnel:     async () => (await import("./tunnel.ts")).create(),
  minimal:    async () => (await import("./minimal.ts")).create(),
};

const META: { id: string; name: string }[] = [
  { id: "flythrough", name: "Fly-through" },
  { id: "mv",         name: "Music video" },
  { id: "planet",     name: "Planet" },
  { id: "winamp",     name: "Winamp" },
  { id: "tunnel",     name: "Tunnel" },
  { id: "minimal",    name: "Minimal" },
];

export function listVibes(): { id: string; name: string }[] {
  return META.slice();
}
