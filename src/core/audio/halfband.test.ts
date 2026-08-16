import { describe, expect, it } from 'vitest';
import { HalfbandDecimator } from './halfband';

function generateSine(
  freqHz: number,
  fs: number,
  numSamples: number,
  amplitude = 1
): Float32Array {
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / fs);
  }
  return out;
}

/** 正方向ゼロクロス間隔から周波数を推定する。フィルタの群遅延・位相シフトに影響されない。 */
function estimateFrequencyByZeroCrossings(signal: Float32Array, fs: number): number {
  let firstIdx = -1;
  let lastIdx = -1;
  let crossings = 0;
  for (let i = 1; i < signal.length; i++) {
    if (signal[i - 1] < 0 && signal[i] >= 0) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
      crossings++;
    }
  }
  if (crossings < 2) return 0;
  const cycles = crossings - 1;
  const sampleSpan = lastIdx - firstIdx;
  return (cycles * fs) / sampleSpan;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}

function processInBlocks(input: Float32Array, blockSize: number): Float32Array {
  const decimator = new HalfbandDecimator();
  const chunks: Float32Array[] = [];
  for (let i = 0; i < input.length; i += blockSize) {
    const block = input.subarray(i, Math.min(i + blockSize, input.length));
    chunks.push(decimator.process(block));
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

describe('HalfbandDecimator', () => {
  const FS_IN = 48000;
  const FS_OUT = FS_IN / 2;
  const FREQ = 440;
  const DURATION_S = 0.5;
  const numInputSamples = Math.floor(FS_IN * DURATION_S);

  it('halves the sample rate (2:1 decimation)', () => {
    const input = generateSine(FREQ, FS_IN, numInputSamples, 1);
    const output = processInBlocks(input, 128);
    // 出力長は入力長の約半分(間引き位相の端数で ±1 程度の誤差を許容)
    expect(output.length).toBeGreaterThanOrEqual(Math.floor(numInputSamples / 2) - 1);
    expect(output.length).toBeLessThanOrEqual(Math.ceil(numInputSamples / 2) + 1);
  });

  it('preserves 440Hz frequency and amplitude (<1dB decay) at 24kHz output, fed in 128-sample blocks', () => {
    const input = generateSine(FREQ, FS_IN, numInputSamples, 1);
    const output = processInBlocks(input, 128);

    // フィルタの起動過渡(群遅延)を避け、定常区間のみで評価する。
    const skipStart = 300;
    const skipEnd = 100;
    const steadyState = output.subarray(skipStart, output.length - skipEnd);

    const detectedFreq = estimateFrequencyByZeroCrossings(steadyState, FS_OUT);
    expect(Math.abs(detectedFreq - FREQ)).toBeLessThan(2);

    const inputRms = 1 / Math.sqrt(2); // 振幅1の正弦波の理論RMS
    const outputRms = rms(steadyState);
    const dbDelta = 20 * Math.log10(outputRms / inputRms);
    expect(Math.abs(dbDelta)).toBeLessThan(1);
  });

  it('produces (numerically) identical output whether fed as one block or split into 128-sample blocks', () => {
    const input = generateSine(FREQ, FS_IN, numInputSamples, 1);
    const whole = processInBlocks(input, input.length);
    const chunked = processInBlocks(input, 128);

    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i], 5);
    }
  });

  it('remains continuous across odd-length blocks (state carried correctly)', () => {
    const input = generateSine(FREQ, FS_IN, numInputSamples, 1);
    const whole = processInBlocks(input, input.length);
    const oddChunked = processInBlocks(input, 137); // 奇数長ブロック

    expect(oddChunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(oddChunked[i]).toBeCloseTo(whole[i], 5);
    }
  });

  it('reset() clears filter history and decimation phase back to the initial state', () => {
    const input = generateSine(FREQ, FS_IN, numInputSamples, 1);
    const decimator = new HalfbandDecimator();

    const firstPass: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128) {
      firstPass.push(decimator.process(input.subarray(i, Math.min(i + 128, input.length))));
    }
    decimator.reset();

    const secondPass: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128) {
      secondPass.push(decimator.process(input.subarray(i, Math.min(i + 128, input.length))));
    }

    expect(secondPass.length).toBe(firstPass.length);
    for (let c = 0; c < firstPass.length; c++) {
      expect(secondPass[c].length).toBe(firstPass[c].length);
      for (let i = 0; i < firstPass[c].length; i++) {
        expect(secondPass[c][i]).toBeCloseTo(firstPass[c][i], 6);
      }
    }
  });
});
