// Global RAF tick shared by every PreviewCanvas in the panel.
//
// Ports the design's `startGlobalTick` / `subscribeTick` helpers. The synthetic
// 105 BPM beat is kept as a fallback so the previews look alive even before
// any live audio data has been plumbed in. Real Link/audio data can override
// the source via `setLiveAudio()` (per-frame snapshot) — see Panel/state wiring
// once the WS pipeline produces an `AudioFrame`-shaped value here.

export interface PreviewAudioFrame {
  /** Wall-clock seconds since page load (or extrapolated link beat seconds). */
  t: number;
  /** Beat-onset envelope, 0..1, brief spike on each beat. */
  beat: number;
  /** Bass band, 0..1. */
  bass: number;
  /** Mid band, 0..1. */
  mid: number;
  /** Treble band, 0..1. */
  treble: number;
}

export type PreviewTickListener = (audio: PreviewAudioFrame, dt: number) => void;
export type PreviewRenderFn = (
  ctx: CanvasRenderingContext2D,
  audio: PreviewAudioFrame,
  dt: number,
  w: number,
  h: number,
) => void;

const tickSubs = new Set<PreviewTickListener>();

/** When set, overrides the synthetic 105 BPM stand-in for the next frame. */
let liveAudio: PreviewAudioFrame | null = null;

/** Replace the synthetic source for one frame's worth of preview animation.
 *  Callers (e.g. the WS-driven state hook) should invoke this each tick they
 *  want to drive previews; the synthetic source resumes if calls stop. */
export function setLiveAudio(audio: PreviewAudioFrame | null): void {
  liveAudio = audio;
}

export function subscribeTick(fn: PreviewTickListener): () => void {
  tickSubs.add(fn);
  return () => {
    tickSubs.delete(fn);
  };
}

let started = false;
function startGlobalTick(): void {
  if (started) return;
  started = true;
  let last = performance.now();
  const loop = (): void => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    let audio: PreviewAudioFrame;
    if (liveAudio) {
      audio = liveAudio;
    } else {
      // Simulate a beat at 105 BPM (matches the design's stand-in).
      const phase = (now / 1000) * (105 / 60);
      const beat = Math.pow(Math.max(0, Math.sin(phase * Math.PI * 2)), 4);
      audio = {
        t: now / 1000,
        beat,
        bass: 0.4 + 0.4 * beat + 0.2 * Math.sin(now / 800),
        mid: 0.3 + 0.3 * Math.sin(now / 500 + 1),
        treble: 0.2 + 0.3 * Math.abs(Math.sin(now / 200 + 2)),
      };
    }
    for (const fn of tickSubs) fn(audio, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Boot the tick lazily on module load — same behavior as the design.
startGlobalTick();
