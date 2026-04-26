import type { Vibe } from "../types.ts";

export const vibes: Record<string, () => Promise<Vibe>> = {
  winamp: async () => (await import("./winamp.ts")).create(),
  tunnel: async () => (await import("./tunnel.ts")).create(),
  minimal: async () => (await import("./minimal.ts")).create(),
};

const META: { id: string; name: string }[] = [
  { id: "winamp", name: "Winamp" },
  { id: "tunnel", name: "Tunnel" },
  { id: "minimal", name: "Minimal" },
];

export function listVibes(): { id: string; name: string }[] {
  return META.slice();
}
