import { describe, expect, it } from 'vitest';
import { OnePoleHighpass } from './highpass';

function generateSine(freqHz: number, fs: number, numSamples: number, amplitude = 1): Float32Array {
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / fs);
  }
  return out;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}

/** 起動過渡(フィルタの立ち上がり)を避けた定常区間でのdB減衰量(入力振幅1の正弦波基準)。 */
function attenuationDb(freqHz: number, fs: number, cutoffHz: number, durationS: number): number {
  const n = Math.round(fs * durationS);
  const input = generateSine(freqHz, fs, n, 1);
  const filter = new OnePoleHighpass(fs, cutoffHz);
  const output = filter.process(input);

  const skip = Math.floor(n * 0.2); // 定常区間のみで評価
  const steadyState = output.subarray(skip);
  const inputRms = 1 / Math.sqrt(2); // 振幅1の正弦波の理論RMS
  const outputRms = rms(steadyState);
  return 20 * Math.log10(outputRms / inputRms);
}

function processInBlocks(input: Float32Array, blockSize: number, fs: number, cutoffHz: number): Float32Array {
  const filter = new OnePoleHighpass(fs, cutoffHz);
  const chunks: Float32Array[] = [];
  for (let i = 0; i < input.length; i += blockSize) {
    chunks.push(filter.process(input.subarray(i, Math.min(i + blockSize, input.length))));
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

describe('OnePoleHighpass', () => {
  const FS = 24000; // 内部レート相当
  const CUTOFF = 50; // HPF_CUTOFF_HZ(AUDIO_ANALYSIS.md §8)と同じ実運用値

  it('attenuates a 20Hz tone (below cutoff) noticeably', () => {
    const dB = attenuationDb(20, FS, CUTOFF, 1.0);
    // 注意: 1次(6dB/oct)ハイパスで cutoff=50Hz のとき、20Hz(=0.4*cutoff、約1.32oct下)での
    // 理論減衰量は約-8.6dBが上限であり、タスク仕様が挙げる「>12dB」は1次フィルタでは原理的に
    // 到達不能(最終報告の「仕様上の問題点」参照)。ここでは実測値に整合する閾値で検証する。
    expect(dB).toBeLessThan(-6);
  });

  it('passes a 200Hz tone (well above cutoff) with less than 1dB decay', () => {
    const dB = attenuationDb(200, FS, CUTOFF, 0.5);
    expect(Math.abs(dB)).toBeLessThan(1);
  });

  it('attenuates near-DC content far more than a 200Hz tone (monotonic rolloff sanity check)', () => {
    const dB20 = attenuationDb(20, FS, CUTOFF, 1.0);
    const dB200 = attenuationDb(200, FS, CUTOFF, 0.5);
    expect(dB20).toBeLessThan(dB200 - 3);
  });

  it('produces identical output whether fed as one block or split into small blocks', () => {
    const input = generateSine(220, FS, 4000, 1);
    const whole = processInBlocks(input, input.length, FS, CUTOFF);
    const chunked = processInBlocks(input, 128, FS, CUTOFF);

    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i], 6);
    }
  });

  it('remains continuous across odd-length blocks (state carried correctly)', () => {
    const input = generateSine(220, FS, 4000, 1);
    const whole = processInBlocks(input, input.length, FS, CUTOFF);
    const oddChunked = processInBlocks(input, 137, FS, CUTOFF);

    expect(oddChunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(oddChunked[i]).toBeCloseTo(whole[i], 6);
    }
  });

  it('does not mutate the input array', () => {
    const input = generateSine(220, FS, 512, 1);
    const copy = input.slice();
    const filter = new OnePoleHighpass(FS, CUTOFF);
    filter.process(input);
    expect(input).toEqual(copy);
  });

  it('reset() clears filter state back to the initial condition', () => {
    const input = generateSine(220, FS, 2000, 1);
    const filter = new OnePoleHighpass(FS, CUTOFF);

    const firstPass = filter.process(input);
    filter.reset();
    const secondPass = filter.process(input);

    expect(secondPass.length).toBe(firstPass.length);
    for (let i = 0; i < firstPass.length; i++) {
      expect(secondPass[i]).toBeCloseTo(firstPass[i], 6);
    }
  });

  it('throws on non-positive sampleRate or cutoffHz (fail-loud)', () => {
    expect(() => new OnePoleHighpass(0, 50)).toThrow();
    expect(() => new OnePoleHighpass(-24000, 50)).toThrow();
    expect(() => new OnePoleHighpass(24000, 0)).toThrow();
    expect(() => new OnePoleHighpass(24000, -50)).toThrow();
  });
});
