// Palette literal copied verbatim from the design's panel.jsx.
// This is the single source of truth for control-panel colors.

export const C = {
  bg: "#0a0a0c",
  bg2: "#121316",
  bg3: "#1a1c20",
  bg4: "#22252a",
  line: "#2a2d33",
  lineSoft: "#1f2126",
  text: "#e8eaee",
  textDim: "#8a8f96",
  textMute: "#52575e",
  accent: "#7cffb2",
  red: "#ff5b5b",
  yellow: "#ffd84a",
  blue: "#5b8cff",
  pink: "#ff5ea8",
} as const;

export type Palette = typeof C;
