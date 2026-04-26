import type { AudioCapture, AudioFrame } from "../types";
import { bucketize } from "./fft";

type Listener = (f: AudioFrame) => void;

const FFT_SIZE = 2048; // ~43Hz bin width @ 48kHz; tight enough for bass, cheap enough for 60Hz RAF
const SMOOTHING = 0.7;
const ROLLING_MAX_DECAY = 0.9995; // auto-gain: leak the rolling max so silence eventually re-normalizes
const BASS_HISTORY_MS = 500;
const BEAT_THRESHOLD = 1.4;
const BEAT_REFRACTORY_MS = 300;

export class WebAudioCapture implements AudioCapture {
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private rafId: number | null = null;
  private synthTimer: number | null = null;
  private freqBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0));
  private timeBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0));

  // Rolling normalizers per band — auto-gain so any input loudness lands in 0..1.
  private maxBass = 1e-3;
  private maxMid = 1e-3;
  private maxTreble = 1e-3;
  private maxLevel = 1e-3;

  // Beat state.
  private bassHistory: { t: number; v: number }[] = [];
  private lastBeatT = 0;
  private prevBeat = 0;

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.mediaStream = stream;
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      src.connect(analyser);
      this.analyser = analyser;
      this.freqBuf = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));
      this.timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.startLoop();
    } catch (err) {
      console.warn("[Ljay] audio capture: getUserMedia failed, falling back to synthetic 120 BPM source.", err);
      this.startSynthetic();
    }
  }

  async stop(): Promise<void> {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.synthTimer !== null) {
      window.clearInterval(this.synthTimer);
      this.synthTimer = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop();
      this.mediaStream = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.analyser = null;
  }

  // -------- internals --------

  private startLoop(): void {
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.emitRealFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private emitRealFrame(): void {
    const analyser = this.analyser;
    const ctx = this.ctx;
    if (!analyser || !ctx) return;
    const t = performance.now();

    analyser.getFloatFrequencyData(this.freqBuf);
    analyser.getFloatTimeDomainData(this.timeBuf);

    const { bass: rawBass, mid: rawMid, treble: rawTreble } = bucketize(
      this.freqBuf, ctx.sampleRate, analyser.fftSize,
    );

    // RMS of time-domain → level.
    let sumSq = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const x = this.timeBuf[i];
      sumSq += x * x;
    }
    const rawLevel = Math.sqrt(sumSq / this.timeBuf.length);

    // Update rolling maxima (with leak so we re-gain after loud sections).
    this.maxBass = Math.max(this.maxBass * ROLLING_MAX_DECAY, rawBass, 1e-3);
    this.maxMid = Math.max(this.maxMid * ROLLING_MAX_DECAY, rawMid, 1e-3);
    this.maxTreble = Math.max(this.maxTreble * ROLLING_MAX_DECAY, rawTreble, 1e-3);
    this.maxLevel = Math.max(this.maxLevel * ROLLING_MAX_DECAY, rawLevel, 1e-3);

    const bass = clamp01(rawBass / this.maxBass);
    const mid = clamp01(rawMid / this.maxMid);
    const treble = clamp01(rawTreble / this.maxTreble);
    const level = clamp01(rawLevel / this.maxLevel);

    // Beat: bass > 1.4× rolling 0.5s mean, with refractory window.
    this.bassHistory.push({ t, v: rawBass });
    while (this.bassHistory.length > 0 && t - this.bassHistory[0].t > BASS_HISTORY_MS) {
      this.bassHistory.shift();
    }
    let mean = 0;
    for (const h of this.bassHistory) mean += h.v;
    mean = this.bassHistory.length ? mean / this.bassHistory.length : 0;

    let beat = this.prevBeat * 0.85;
    if (mean > 0 && rawBass > BEAT_THRESHOLD * mean && t - this.lastBeatT > BEAT_REFRACTORY_MS) {
      beat = 1;
      this.lastBeatT = t;
    }
    this.prevBeat = beat;

    // Down-sample fft to 512 bins for vibe consumers.
    const fft = downsampleFft(this.freqBuf, 512);

    this.emit({ t, bass, mid, treble, level, beat, fft });
  }

  private startSynthetic(): void {
    const startedAt = performance.now();
    const bpm = 120;
    const beatPeriodMs = 60_000 / bpm; // 500ms
    let lastBeatIdx = -1;
    this.synthTimer = window.setInterval(() => {
      const t = performance.now();
      const elapsed = t - startedAt;
      const phase = (elapsed / beatPeriodMs) * 2 * Math.PI;
      const bass = 0.5 + 0.5 * Math.sin(phase);
      const mid = 0.4 + 0.3 * Math.sin(phase * 0.5 + 1);
      const treble = 0.35 + 0.3 * Math.sin(phase * 1.7 + 2);
      const level = 0.4 + 0.3 * Math.sin(phase * 0.25);

      const beatIdx = Math.floor(elapsed / beatPeriodMs);
      let beat = this.prevBeat * 0.85;
      if (beatIdx !== lastBeatIdx) {
        beat = 1;
        lastBeatIdx = beatIdx;
      }
      this.prevBeat = beat;

      this.emit({
        t,
        bass: clamp01(bass),
        mid: clamp01(mid),
        treble: clamp01(treble),
        level: clamp01(level),
        beat,
      });
    }, 1000 / 60);
  }

  private emit(frame: AudioFrame): void {
    for (const l of this.listeners) l(frame);
  }
}

function clamp01(x: number): number {
  if (!isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function downsampleFft(src: Float32Array, target: number): Float32Array {
  if (src.length === target) return src.slice();
  const out = new Float32Array(target);
  const ratio = src.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(src.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end; j++) {
      const v = src[j];
      if (isFinite(v)) { sum += v; n++; }
    }
    out[i] = n ? sum / n : -120;
  }
  return out;
}
