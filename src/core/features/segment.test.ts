import { describe, expect, it } from 'vitest';
import { analyzePhonation, centsVsTarget, sampleDurationsMs } from './segment';
import { midiToHz } from '../pitch/conversions';
import type { ProcessedPitchSample, Voicing } from '../types';

const HOP_MS = 10;

function sample(index: number, midiNote: number, voicing: Voicing = 'voiced'): ProcessedPitchSample {
  const freq = midiToHz(midiNote);
  return {
    sampleIndex: index,
    timestampMs: index * HOP_MS,
    frequencyHzForScoring: freq,
    frequencyHzForDisplay: freq,
    midiNote,
    voicing,
  };
}

/** segments を連結して連続した(index/timestampMs が途切れない)サンプル列を作る。 */
function buildTimeline(
  segments: { count: number; midiNote: number; voicing?: Voicing }[]
): ProcessedPitchSample[] {
  const result: ProcessedPitchSample[] = [];
  let idx = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.count; i++) {
      result.push(sample(idx, seg.midiNote, seg.voicing ?? 'voiced'));
      idx++;
    }
  }
  return result;
}

describe('analyzePhonation', () => {
  it('detects onset at the head of the first voiced run reaching 150ms, retroactively', () => {
    // silent 5サンプル(50ms) → voiced 30サンプル(300ms)
    const samples = buildTimeline([
      { count: 5, midiNote: 60, voicing: 'silent' },
      { count: 30, midiNote: 60, voicing: 'voiced' },
    ]);
    const result = analyzePhonation(samples);
    // onset は連続voiced区間の「先頭」= index5 の timestampMs(150ms経過時点ではない)
    expect(result.onsetMs).toBe(50);
    expect(result.voicedMs).toBeCloseTo(300, 5);
  });

  it('ignores a voiced run shorter than 150ms and finds onset in the next run', () => {
    // voiced 10サンプル(100ms、150ms未満) → silent 2サンプル → voiced 20サンプル(200ms)
    const samples = buildTimeline([
      { count: 10, midiNote: 60, voicing: 'voiced' },
      { count: 2, midiNote: 60, voicing: 'silent' },
      { count: 20, midiNote: 60, voicing: 'voiced' },
    ]);
    const result = analyzePhonation(samples);
    // 2番目の連続区間の先頭(index12) = 120ms
    expect(result.onsetMs).toBe(120);
    expect(result.voicedMs).toBeCloseTo(300, 5); // 10+20 voicedサンプル分
  });

  it('returns null onset when no continuous voiced run reaches 150ms', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: 60, voicing: 'voiced' },
      { count: 5, midiNote: 60, voicing: 'silent' },
      { count: 5, midiNote: 60, voicing: 'voiced' },
      { count: 5, midiNote: 60, voicing: 'tooQuiet' },
    ]);
    const result = analyzePhonation(samples);
    expect(result.onsetMs).toBeNull();
  });

  it('returns onsetMs null and voicedMs 0 for an empty sample list', () => {
    const result = analyzePhonation([]);
    expect(result.onsetMs).toBeNull();
    expect(result.voicedMs).toBe(0);
  });

  it('counts only voiced samples toward voicedMs, excluding silent/tooQuiet/unclear', () => {
    const samples = buildTimeline([
      { count: 20, midiNote: 60, voicing: 'voiced' },
      { count: 20, midiNote: 60, voicing: 'tooQuiet' },
      { count: 20, midiNote: 60, voicing: 'unclear' },
      { count: 20, midiNote: 60, voicing: 'silent' },
    ]);
    const result = analyzePhonation(samples);
    expect(result.voicedMs).toBeCloseTo(200, 5); // 先頭20サンプルのみ voiced
  });

  it('carries the original samples array through unchanged', () => {
    const samples = buildTimeline([{ count: 5, midiNote: 60 }]);
    const result = analyzePhonation(samples);
    expect(result.samples).toBe(samples);
  });
});

describe('sampleDurationsMs', () => {
  it('approximates the head sample duration using the adjacent (next) interval', () => {
    const samples = buildTimeline([{ count: 4, midiNote: 60 }]); // t=0,10,20,30
    const durations = sampleDurationsMs(samples);
    expect(durations).toEqual([10, 10, 10, 10]);
  });

  it('returns [0] for a single sample and [] for an empty list', () => {
    expect(sampleDurationsMs([sample(0, 60)])).toEqual([0]);
    expect(sampleDurationsMs([])).toEqual([]);
  });
});

describe('centsVsTarget', () => {
  it('returns 0 when the sample exactly matches the target', () => {
    const s = sample(0, 60);
    expect(centsVsTarget(s, 60)).toBeCloseTo(0, 6);
  });

  it('returns +1200 for one octave above the target and -1200 for one below', () => {
    expect(centsVsTarget(sample(0, 72), 60)).toBeCloseTo(1200, 4);
    expect(centsVsTarget(sample(0, 48), 60)).toBeCloseTo(-1200, 4);
  });

  it('matches the general cents formula for an arbitrary offset', () => {
    // 60 + 0.5 半音 = 目標より50cent高い
    const s = sample(0, 60.5);
    expect(centsVsTarget(s, 60)).toBeCloseTo(50, 4);
  });
});
