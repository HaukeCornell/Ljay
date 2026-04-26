// Tiny <canvas> that subscribes to the shared RAF tick and runs the supplied
// `render` fn each frame. Ported verbatim from the design's `PreviewCanvas`.

import { useEffect, useRef } from "preact/hooks";
import { subscribeTick, type PreviewRenderFn } from "./tick";

export interface PreviewCanvasProps {
  render: PreviewRenderFn;
  width?: number;
  height?: number;
}

export function PreviewCanvas({
  render,
  width = 320,
  height = 200,
}: PreviewCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = height * dpr;
    ctx.scale(dpr, dpr);
    return subscribeTick((audio, dt) => {
      render(ctx, audio, dt, width, height);
    });
  }, [render, width, height]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
