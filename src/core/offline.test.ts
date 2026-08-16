import { describe, expect, it } from 'vitest';
import { runPipelineOffline } from './offline';
import { centsBetween } from './pitch/conversions';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 先頭 silenceMs は完全な無音(0)、以降 durationMs 末尾までを 440Hz サイン波にした合成PCMを作る。
 * 先頭の無音区間が offline.ts のノイズフロア自動推定(先頭 NOISE_MEASURE_MS=500ms)を機能させるために
 * silenceMs は 500ms を確実に超える値にすること(YINのhop粒度でトーン開始直後の1〜2ホップは
 * 部分的にトーンを含みうるため、500msちょうどだと推定窓にトーンの立ち上がりが混入し、
 * ノイズフロアが信号自身のレベルまで底上げされて gate が信号を締め出してしまう — 実測で確認済み)。
 */
function makeSilenceThenTone(
  freqHz: number,
  amplitude: number,
  silenceMs: number,
  durationMs: number,
  fs: number
): Float32Array {
  const n = Math.round((durationMs / 1000) * fs);
  const silenceSamples = Math.round((silenceMs / 1000) * fs);
  const pcm = new Float32Array(n);
  for (let i = silenceSamples; i < n; i++) {
    pcm[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / fs);
  }
  return pcm;
}

describe('runPipelineOffline', () => {
  it('440Hz合成サイン波(2秒@48kHz)を通すと voiced 区間の中央値が440±10centに入る', () => {
    const fs = 48000;
    const pcm = makeSilenceThenTone(440, 0.3, 600, 2000, fs);

    const { raw, processed } = runPipelineOffline(pcm, fs);

    expect(raw.length).toBeGreaterThan(0);
    expect(processed.length).toBe(raw.length);

    const voicedHz = processed
      .filter((p) => p.voicing === 'voiced')
      .map((p) => p.frequencyHzForScoring);
    expect(voicedHz.length).toBeGreaterThan(0);

    const med = median(voicedHz);
    const biasCents = centsBetween(med, 440);
    expect(
      Math.abs(biasCents),
      `median=${med.toFixed(3)}Hz bias=${biasCents.toFixed(3)}cent n=${voicedHz.length}`
    ).toBeLessThanOrEqual(10);
  });

  it('先頭500ms(ノイズ測定相当)より後は voicing="voiced" が支配的になる', () => {
    const fs = 48000;
    const pcm = makeSilenceThenTone(440, 0.3, 600, 2000, fs);

    const { processed } = runPipelineOffline(pcm, fs);
    const afterWarmup = processed.filter((p) => p.timestampMs > 500);
    expect(afterWarmup.length).toBeGreaterThan(0);

    const voicedRatio = afterWarmup.filter((p) => p.voicing === 'voiced').length / afterWarmup.length;
    expect(voicedRatio, `voicedRatio=${voicedRatio}`).toBeGreaterThan(0.8);
  });

  it('先頭500msに有限dBの音が無ければノイズフロアは-80dBFSにフォールバックし、無音区間はsilentのままになる', () => {
    const fs = 48000;
    const pcm = makeSilenceThenTone(440, 0.3, 600, 2000, fs);
    const { processed } = runPipelineOffline(pcm, fs);

    // 無音区間(先頭600ms、YINバッファ充足の遅延を差し引いても十分手前)は silent のはず。
    const duringSilence = processed.filter((p) => p.timestampMs > 100 && p.timestampMs < 550);
    expect(duringSilence.length).toBeGreaterThan(0);
    expect(duringSilence.every((p) => p.voicing === 'silent')).toBe(true);
  });

  it('contextSampleRateが0以下ならfail-loudでthrowする', () => {
    expect(() => runPipelineOffline(new Float32Array(10), 0)).toThrow(/contextSampleRate/);
    expect(() => runPipelineOffline(new Float32Array(10), -48000)).toThrow(/contextSampleRate/);
  });

  it('YINのウォームアップに満たない短い入力はraw/processedとも空配列を返す', () => {
    const { raw, processed } = runPipelineOffline(new Float32Array(100), 48000);
    expect(raw).toEqual([]);
    expect(processed).toEqual([]);
  });

  it('無音のみの入力はエラーにならずfrequencyHz=0/silentのサンプルを返す', () => {
    const fs = 24000;
    const pcm = new Float32Array(Math.round(fs * 1.0)); // 1秒無音
    const { raw, processed } = runPipelineOffline(pcm, fs);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.frequencyHz === 0)).toBe(true);
    expect(processed.every((p) => p.voicing === 'silent')).toBe(true);
  });
});
