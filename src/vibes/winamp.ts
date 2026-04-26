import type { AudioFrame, LyricStyle, Vibe, VibeHost } from "../types.ts";

// butterchurn ships without TS types in the beta. Treat as `any` and call defensively.
// API path chosen: real (silent) AudioContext + synthesized oscillators driving butterchurn's
// internal AnalyserNode via connectAudio(). Our AudioFrame.{bass,mid,treble,level} drive the
// gain on three sine oscillators sitting in those bands so butterchurn sees a "real" spectrum
// without us needing to mutate its private analyser.

interface ButterchurnVisualizer {
  loadPreset(preset: unknown, blendTime?: number): void;
  setRendererSize(w: number, h: number): void;
  connectAudio(node: AudioNode): void;
  render(opts?: unknown): void;
  destroy?: () => void;
}

export function create(): Vibe {
  let visualizer: ButterchurnVisualizer | null = null;
  let audioCtx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let muteGain: GainNode | null = null;
  let oscBass: OscillatorNode | null = null;
  let oscMid: OscillatorNode | null = null;
  let oscTreble: OscillatorNode | null = null;
  let gainBass: GainNode | null = null;
  let gainMid: GainNode | null = null;
  let gainTreble: GainNode | null = null;
  let unsubResize: (() => void) | null = null;
  let host: VibeHost | null = null;
  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const lyricStyle: LyricStyle = {
    font: '"Times New Roman", "Georgia", serif',
    weight: 700,
    color: "#ffffff",
    shadow:
      "0 0 8px rgba(255,0,255,0.85), 0 0 18px rgba(0,255,255,0.7), 0 2px 0 rgba(0,0,0,0.6)",
    animation: "snippet",
    snippetWindow: 2,
  };

  return {
    id: "winamp",
    name: "Winamp",
    lyricStyle,

    async mount(h: VibeHost) {
      host = h;
      const [butterchurnMod, presetsMod] = await Promise.all([
        import("butterchurn"),
        import("butterchurn-presets"),
      ]);
      // ESM/CJS interop: prefer .default if present.
      const butterchurn: any = (butterchurnMod as any).default ?? butterchurnMod;
      const presets: Record<string, unknown> =
        ((presetsMod as any).default ?? presetsMod) as Record<string, unknown>;

      const Ctor: any = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctor();
      audioCtx = ctx;

      // Build the silent synthetic spectrum graph:
      //   oscBass(60Hz) -> gainBass --\
      //   oscMid(700Hz) -> gainMid  ---+--> masterGain --> butterchurn analyser
      //   oscTreble(6kHz)-> gainTreble-/                \-> muteGain (gain=0) -> destination
      // We never route to destination at audible volume; muteGain at 0 just keeps oscillators
      // alive in browsers that GC orphan oscillators.
      oscBass = ctx.createOscillator();
      oscMid = ctx.createOscillator();
      oscTreble = ctx.createOscillator();
      oscBass.frequency.value = 60;
      oscMid.frequency.value = 700;
      oscTreble.frequency.value = 6000;

      gainBass = ctx.createGain();
      gainMid = ctx.createGain();
      gainTreble = ctx.createGain();
      gainBass.gain.value = 0;
      gainMid.gain.value = 0;
      gainTreble.gain.value = 0;

      masterGain = ctx.createGain();
      masterGain.gain.value = 1;
      muteGain = ctx.createGain();
      muteGain.gain.value = 0;

      oscBass.connect(gainBass).connect(masterGain);
      oscMid.connect(gainMid).connect(masterGain);
      oscTreble.connect(gainTreble).connect(masterGain);
      masterGain.connect(muteGain).connect(ctx.destination);

      try {
        oscBass.start();
        oscMid.start();
        oscTreble.start();
      } catch {}

      // Chrome blocks AudioContext.resume() until a user gesture. Kicking off the
      // resume is fine — but DON'T await it, or boot stalls forever before any click.
      void ctx.resume().catch(() => {});

      visualizer = butterchurn.createVisualizer(ctx, h.canvas, {
        width: h.width,
        height: h.height,
        pixelRatio: Math.min(window.devicePixelRatio, 2),
        textureRatio: 1,
      }) as ButterchurnVisualizer;

      // Wire our synthetic source into butterchurn's analyser.
      try {
        visualizer.connectAudio(masterGain);
      } catch (e) {
        console.warn("butterchurn connectAudio failed", e);
      }

      // Pick a preset. Try a known-good name; fall back to the first preset available.
      // butterchurn-presets has shipped both as a flat map and as { getPresets(): {...} }.
      let presetMap: Record<string, unknown> = presets;
      if (typeof (presets as any).getPresets === "function") {
        try {
          presetMap = (presets as any).getPresets() as Record<string, unknown>;
        } catch {}
      }
      const preferredKey = "Flexi - mindblob mix [stahlregen jelly fish]";
      let preset: unknown = presetMap[preferredKey];
      if (!preset) {
        const values = Object.values(presetMap).filter((v) => v && typeof v === "object");
        preset = values[0];
      }
      if (preset) {
        try {
          visualizer.loadPreset(preset, 0);
        } catch (e) {
          console.warn("butterchurn loadPreset failed", e);
        }
      }

      visualizer.setRendererSize(h.width, h.height);
      unsubResize = h.onResize((w, hpx) => {
        visualizer?.setRendererSize(w, hpx);
      });
    },

    update(audio: AudioFrame | null, _dtMs: number) {
      if (!visualizer || !audioCtx || !gainBass || !gainMid || !gainTreble) return;
      const now = audioCtx.currentTime;
      const beatScale = reducedMotion ? 0.5 : 1;
      const bass = (audio?.bass ?? 0) * beatScale;
      const mid = (audio?.mid ?? 0) * beatScale;
      const treble = (audio?.treble ?? 0) * beatScale;
      // setTargetAtTime smooths jitter and avoids zipper noise even though output is muted.
      gainBass.gain.setTargetAtTime(bass, now, 0.02);
      gainMid.gain.setTargetAtTime(mid, now, 0.02);
      gainTreble.gain.setTargetAtTime(treble, now, 0.02);
      try {
        visualizer.render();
      } catch (e) {
        console.error("butterchurn render error", e);
      }
    },

    unmount() {
      unsubResize?.();
      unsubResize = null;
      try {
        oscBass?.stop();
        oscMid?.stop();
        oscTreble?.stop();
      } catch {}
      try {
        oscBass?.disconnect();
        oscMid?.disconnect();
        oscTreble?.disconnect();
        gainBass?.disconnect();
        gainMid?.disconnect();
        gainTreble?.disconnect();
        masterGain?.disconnect();
        muteGain?.disconnect();
      } catch {}
      try {
        visualizer?.destroy?.();
      } catch {}
      try {
        audioCtx?.close();
      } catch {}
      visualizer = null;
      audioCtx = null;
      masterGain = null;
      muteGain = null;
      oscBass = oscMid = oscTreble = null;
      gainBass = gainMid = gainTreble = null;
      host = null;
    },
  };
}
