import { describe, expect, it } from 'vitest';
import { aggregateSteps, evaluateStep, type StepEvaluation } from './steps';
import type { ProcessedPitchSample, Voicing } from '../types';

const HOP_MS = 10;
// RANGE_STEP_MIN_VOICED_MS(400ms)ちょうどになるサンプル数(count * HOP_MS)
const SAMPLES_AT_MIN_VOICED = 40;

/** 一定midiNote・一定voicingのProcessedPitchSample列をHOP_MS刻みで作る。 */
function buildProcessed(count: number, midi: number, voicing: Voicing = 'voiced'): ProcessedPitchSample[] {
  const arr: ProcessedPitchSample[] = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      sampleIndex: i,
      timestampMs: i * HOP_MS,
      frequencyHzForScoring: 0,
      frequencyHzForDisplay: 0,
      midiNote: midi,
      voicing,
    });
  }
  return arr;
}

describe('evaluateStep', () => {
  const target = 60; // ド4

  it('matches exactly at the cents boundary (150) with enough voiced time', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target + 150 / 100); // +150cent
    const r = evaluateStep(processed, target);
    expect(r.voicedMs).toBe(400);
    expect(r.medianCents).toBe(150);
    expect(r.matched).toBe(true);
    expect(r.comfortable).toBe(false); // 150 > COMFORT(75)
  });

  it('does not match just over the cents boundary (151)', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target + 151 / 100);
    const r = evaluateStep(processed, target);
    expect(r.matched).toBe(false);
    expect(r.comfortable).toBe(false);
  });

  it('does not match when voiced time is just under the minimum (390ms < 400ms)', () => {
    const processed = buildProcessed(39, target); // 39 * 10ms = 390ms、cent差ゼロ
    const r = evaluateStep(processed, target);
    expect(r.voicedMs).toBe(390);
    expect(r.matched).toBe(false);
  });

  it('is comfortable exactly at the comfort boundary (75 cents)', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target + 75 / 100);
    const r = evaluateStep(processed, target);
    expect(r.matched).toBe(true);
    expect(r.comfortable).toBe(true);
  });

  it('matched but wobbly (σ > RANGE_STEP_COMFORT_SIGMA_CENTS) is NOT comfortable — 「楽」=ぶれずに出せたこと', () => {
    // 目標ちょうどを中心に ±120cent 交互に振る → 中央値≈0(matched)だが σ≈120 > 50
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target).map((p, i) => ({
      ...p,
      midiNote: target + (i % 2 === 0 ? 1.2 : -1.2),
    }));
    const r = evaluateStep(processed, target);
    expect(r.matched).toBe(true);
    expect(r.sigmaCents).not.toBeNull();
    expect(r.sigmaCents!).toBeGreaterThan(50);
    expect(r.comfortable).toBe(false);
  });

  it('matches but is not comfortable just over the comfort boundary (76 cents)', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target + 76 / 100);
    const r = evaluateStep(processed, target);
    expect(r.matched).toBe(true);
    expect(r.comfortable).toBe(false);
  });

  it('handles negative offsets (below target) symmetrically', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target - 75 / 100);
    const r = evaluateStep(processed, target);
    expect(r.medianCents).toBe(-75);
    expect(r.matched).toBe(true);
    expect(r.comfortable).toBe(true);
  });

  it('returns null medianCents and unmatched when there is no voiced sample at all', () => {
    const processed = buildProcessed(SAMPLES_AT_MIN_VOICED, target, 'silent');
    const r = evaluateStep(processed, target);
    expect(r.medianCents).toBeNull();
    expect(r.voicedMs).toBe(0);
    expect(r.matched).toBe(false);
    expect(r.comfortable).toBe(false);
  });

  it('returns unmatched for an empty sample array', () => {
    const r = evaluateStep([], target);
    expect(r.medianCents).toBeNull();
    expect(r.voicedMs).toBe(0);
    expect(r.matched).toBe(false);
  });
});

describe('aggregateSteps', () => {
  const evalOf = (matched: boolean, comfortable: boolean): StepEvaluation => ({
    matched,
    comfortable,
    medianCents: 0,
    sigmaCents: 0,
    voicedMs: 1000,
  });

  it('takes comfort min/max from comfortable steps and full min/max from matched steps', () => {
    const steps = [
      { targetMidi: 60, eval: evalOf(true, true) },
      { targetMidi: 58, eval: evalOf(true, false) }, // matchedのみ(fullを広げる)
      { targetMidi: 55, eval: evalOf(false, false) }, // unmatched(集計対象外)
      { targetMidi: 62, eval: evalOf(true, true) },
    ];
    const r = aggregateSteps(steps);
    expect(r.ok).toBe(true);
    expect(r.fullLowMidi).toBe(58);
    expect(r.fullHighMidi).toBe(62);
    expect(r.comfortLowMidi).toBe(60);
    expect(r.comfortHighMidi).toBe(62);
  });

  it('returns comfort=null when there are matched steps but none comfortable', () => {
    const steps = [
      { targetMidi: 60, eval: evalOf(true, false) },
      { targetMidi: 58, eval: evalOf(true, false) },
    ];
    const r = aggregateSteps(steps);
    expect(r.ok).toBe(true);
    expect(r.fullLowMidi).toBe(58);
    expect(r.fullHighMidi).toBe(60);
    expect(r.comfortLowMidi).toBeNull();
    expect(r.comfortHighMidi).toBeNull();
  });

  it('fails (ok=false, all null) when no step matched — not even the start note', () => {
    const steps = [{ targetMidi: 55, eval: evalOf(false, false) }];
    const r = aggregateSteps(steps);
    expect(r.ok).toBe(false);
    expect(r.fullLowMidi).toBeNull();
    expect(r.fullHighMidi).toBeNull();
    expect(r.comfortLowMidi).toBeNull();
    expect(r.comfortHighMidi).toBeNull();
  });

  it('fails on an empty steps array', () => {
    const r = aggregateSteps([]);
    expect(r.ok).toBe(false);
  });
});
