/**
 * Bucketize a single frame of dB-domain FFT magnitudes into bass/mid/treble.
 *
 * `freqData` is what AnalyserNode.getFloatFrequencyData fills: dB values,
 * typically in [-100, 0]. We convert each bin to linear amplitude (10^(dB/20))
 * so that energies sum sensibly, accumulate per band, and divide by bin count
 * so wider bands aren't unfairly hot.
 */
export function bucketize(
  freqData: Float32Array,
  sampleRate: number,
  fftSize: number,
): { bass: number; mid: number; treble: number } {
  const binHz = sampleRate / fftSize;
  const nyquistBin = freqData.length;

  const bassEnd = Math.min(nyquistBin, Math.floor(250 / binHz));
  const midEnd = Math.min(nyquistBin, Math.floor(2000 / binHz));
  const trebleEnd = nyquistBin;

  let bassSum = 0, midSum = 0, trebleSum = 0;
  let bassN = 0, midN = 0, trebleN = 0;

  for (let i = 0; i < trebleEnd; i++) {
    const db = freqData[i];
    if (!isFinite(db)) continue;
    const lin = Math.pow(10, db / 20); // dB → amplitude
    if (i < bassEnd) { bassSum += lin; bassN++; }
    else if (i < midEnd) { midSum += lin; midN++; }
    else { trebleSum += lin; trebleN++; }
  }

  return {
    bass: bassN ? bassSum / bassN : 0,
    mid: midN ? midSum / midN : 0,
    treble: trebleN ? trebleSum / trebleN : 0,
  };
}
