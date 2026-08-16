import { describe, expect, it } from 'vitest';
import { recommend } from './recommend';
import { midiToHz } from '../pitch/conversions';
import type { Diagnosis, ExerciseMetrics, ExerciseResult, ExerciseSpec, ProcessedPitchSample, Voicing } from '../types';

const SPEC: ExerciseSpec = {
  exerciseId: 'ex-level2-single-note',
  levelId: 'level2',
  targets: [{ midiNote: 60, startMs: 0, durationMs: 3000 }],
  phonationMaxMs: 5000,
  guardAfterPlaybackMs: 250,
};

const GOOD_METRICS: ExerciseMetrics = {
  pitchAccuracy: 0.9,
  medianAbsCents: 5,
  pitchStability: 0.9,
  attackAccuracy: 0.9,
};

function sample(midiNote: number, voicing: Voicing = 'voiced'): ProcessedPitchSample {
  const freq = midiToHz(midiNote);
  return {
    sampleIndex: 0,
    timestampMs: 0,
    frequencyHzForScoring: freq,
    frequencyHzForDisplay: freq,
    midiNote,
    voicing,
  };
}

function makeResult(overrides: {
  isValid?: boolean;
  reason?: ExerciseResult['validity']['reason'];
  metrics?: Partial<ExerciseMetrics>;
  samples?: ProcessedPitchSample[];
  spec?: ExerciseSpec;
}): ExerciseResult {
  return {
    spec: overrides.spec ?? SPEC,
    timestamp: 1000,
    paramsVersion: 1,
    validity: { isValid: overrides.isValid ?? true, reason: overrides.reason ?? 'ok' },
    metrics: { ...GOOD_METRICS, ...overrides.metrics },
    octaveOff: 0,
    samples: overrides.samples ?? [],
  };
}

function makeDiagnosis(overrides: Partial<Diagnosis>): Diagnosis {
  return {
    primaryWeakness: null,
    octaveOff: 0,
    isReliable: true,
    rationale: 'normal:pitchAccuracy',
    ...overrides,
  };
}

function expectRunnable(spec: ExerciseSpec) {
  expect(Number.isInteger(spec.targets[0].midiNote)).toBe(true);
  expect(spec.targets[0].durationMs).toBeGreaterThan(0);
  expect(spec.phonationMaxMs).toBe(SPEC.phonationMaxMs);
  expect(spec.guardAfterPlaybackMs).toBe(SPEC.guardAfterPlaybackMs);
}

describe('recommend — retry (invalid validity)', () => {
  it('returns the same spec unchanged with reasonKey=retry', () => {
    const result = makeResult({ isValid: false, reason: 'tooShort' });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, rationale: 'invalid:tooShort' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('retry');
    expect(spec.targets[0].midiNote).toBe(60);
    expect(spec.targets[0].durationMs).toBe(3000);
    expectRunnable(spec);
  });
});

describe('recommend — m-4: retry is unreachable when validity=ok', () => {
  it('falls back to reasonKey=pitchAccuracy (not retry) for an unrecognized primaryWeakness while validity=ok', () => {
    // diagnose.ts の契約上 primaryWeakness は BANDS の3種(またはnull)のみを返すが、
    // Diagnosis.primaryWeakness の型は keyof ExerciseMetrics 全体を許容する。
    // 未知キーが来ても validity=ok の間は 'retry' に落とさない(レビューm-4)。
    const result = makeResult({ isValid: true });
    const diagnosis = makeDiagnosis({ primaryWeakness: 'medianAbsCents', rationale: 'normal:medianAbsCents' });
    const { reasonKey, spec } = recommend(diagnosis, result);
    expect(reasonKey).not.toBe('retry');
    expect(reasonKey).toBe('pitchAccuracy');
    expect(spec.targets[0].midiNote).toBe(60);
  });
});

describe('recommend — octaveOff', () => {
  it('shifts the target +12 semitones when octaveOff=+1', () => {
    // base=55(+12=67)を使う。SPEC既定の60+12=72はTARGET_MIDI_MAX(69)を超えクランプされて
    // しまうため(レビューM-5)、ここでは純粋な+12シフトの挙動を検証する。クランプそのものは
    // 「recommend — M-4/M-5 clamp chaining」で別途検証する。
    const lowerSpec: ExerciseSpec = { ...SPEC, targets: [{ ...SPEC.targets[0], midiNote: 55 }] };
    const result = makeResult({ spec: lowerSpec });
    const diagnosis = makeDiagnosis({ octaveOff: 1, rationale: 'octaveOff' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('octaveOff');
    expect(spec.targets[0].midiNote).toBe(67);
    expect(Number.isInteger(spec.targets[0].midiNote)).toBe(true);
    expect(spec.targets[0].durationMs).toBeGreaterThan(0);
    expect(spec.phonationMaxMs).toBe(SPEC.phonationMaxMs);
    expect(spec.guardAfterPlaybackMs).toBe(SPEC.guardAfterPlaybackMs);
  });

  it('clamps the +12 semitone shift at TARGET_MIDI_MAX(69) when it would otherwise overshoot (M-5)', () => {
    const result = makeResult({}); // SPEC既定 midiNote=60 → 60+12=72 → 69にクランプ
    const diagnosis = makeDiagnosis({ octaveOff: 1, rationale: 'octaveOff' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('octaveOff');
    expect(spec.targets[0].midiNote).toBe(69);
    expectRunnable(spec);
  });

  it('shifts the target -12 semitones when octaveOff=-1', () => {
    const result = makeResult({});
    const diagnosis = makeDiagnosis({ octaveOff: -1, rationale: 'octaveOff' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('octaveOff');
    expect(spec.targets[0].midiNote).toBe(48);
    expectRunnable(spec);
  });

  it('takes priority over validity/primaryWeakness contradictions is not applicable; only octaveOff drives here', () => {
    const result = makeResult({ metrics: { pitchAccuracy: 0.1, pitchStability: 0.1, attackAccuracy: 0.1 } });
    const diagnosis = makeDiagnosis({ octaveOff: 1, primaryWeakness: null, rationale: 'octaveOff' });
    const { reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('octaveOff');
  });
});

describe('recommend — reachTarget', () => {
  it('moves the target toward the voiced median pitch, snapped to a C-major scale note', () => {
    // 2026-08-16 ユーザーフィードバック反映: 目標はハ長調スケール音のみ(scale.ts)。
    // median=63(D#4、黒鍵)→ 最近傍スケール音(同距離タイは低い方)= 62(D4)
    const samples = [sample(63), sample(63), sample(63, 'silent')];
    const result = makeResult({ samples });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, rationale: 'reachTarget' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('reachTarget');
    expect(spec.targets[0].midiNote).toBe(62);
    expectRunnable(spec);
  });

  it('clamps the shift to at most ±5 semitones', () => {
    const samples = [sample(75)]; // +15 semitones away, should clamp to +5
    const result = makeResult({ samples });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, rationale: 'reachTarget' });
    const { spec } = recommend(diagnosis, result);
    expect(spec.targets[0].midiNote).toBe(65); // 60+5
    expectRunnable(spec);
  });

  it('falls back to -3 semitones when there are no voiced samples at all', () => {
    const samples = [sample(70, 'silent'), sample(70, 'tooQuiet')];
    const result = makeResult({ samples });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, rationale: 'reachTarget' });
    const { spec } = recommend(diagnosis, result);
    expect(spec.targets[0].midiNote).toBe(57); // 60-3
    expectRunnable(spec);
  });
});

describe('recommend — pitchAccuracy weak', () => {
  it('keeps the same target and duration', () => {
    const result = makeResult({ metrics: { pitchAccuracy: 0.1 } });
    const diagnosis = makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('pitchAccuracy');
    expect(spec.targets[0].midiNote).toBe(60);
    expect(spec.targets[0].durationMs).toBe(3000);
    expectRunnable(spec);
  });
});

describe('recommend — pitchStability weak', () => {
  it('scales durationMs by 1.5x, clamped to DURATION_MAX_MS(4000), and sets phonationMaxMs=clamp(durationMs*2,5000,8000) (レビューM-4)', () => {
    // SPEC.durationMs=3000 * 1.5 = 4500 → DURATION_MAX_MS(4000)にクランプされる。
    // phonationMaxMs = clamp(4000*2=8000, 5000, 8000) = 8000(元specの5000から実際に変わる)。
    const result = makeResult({ metrics: { pitchStability: 0.1 } });
    const diagnosis = makeDiagnosis({ primaryWeakness: 'pitchStability', rationale: 'normal:pitchStability' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('pitchStability');
    expect(spec.targets[0].durationMs).toBe(4000); // クランプされた値(旧仕様では4500だったがM-4でクランプが入る)
    expect(spec.targets[0].midiNote).toBe(60);
    expect(spec.phonationMaxMs).toBe(8000); // レビューM-4: phonationMaxMsが実際に設定される
    expect(spec.guardAfterPlaybackMs).toBe(SPEC.guardAfterPlaybackMs);
    expect(Number.isInteger(spec.targets[0].midiNote)).toBe(true);
  });

  it('leaves phonationMaxMs untouched for a short base duration where durationMs*2 still falls inside the clamp range', () => {
    // durationMs(元)=1000 → 1.5倍=1500(クランプ内、変更なし)。phonationMaxMs=clamp(3000,5000,8000)=5000。
    const shortSpec: ExerciseSpec = { ...SPEC, targets: [{ ...SPEC.targets[0], durationMs: 1000 }] };
    const result = makeResult({ metrics: { pitchStability: 0.1 }, spec: shortSpec });
    const diagnosis = makeDiagnosis({ primaryWeakness: 'pitchStability', rationale: 'normal:pitchStability' });
    const { spec } = recommend(diagnosis, result);
    expect(spec.targets[0].durationMs).toBe(1500);
    expect(spec.phonationMaxMs).toBe(5000); // clampの下限に張り付く
  });
});

describe('recommend — allGood (C-5)', () => {
  it('shifts the target +2 semitones and reports reasonKey=allGood', () => {
    const result = makeResult({});
    const diagnosis = makeDiagnosis({ primaryWeakness: null, octaveOff: 0, rationale: 'allGood' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('allGood');
    expect(spec.targets[0].midiNote).toBe(62); // 60+2
    expectRunnable(spec);
  });

  it('clamps the +2 semitone shift at TARGET_MIDI_MAX(69)', () => {
    const nearMaxSpec: ExerciseSpec = { ...SPEC, targets: [{ ...SPEC.targets[0], midiNote: 69 }] };
    const result = makeResult({ spec: nearMaxSpec });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, octaveOff: 0, rationale: 'allGood' });
    const { spec } = recommend(diagnosis, result);
    expect(spec.targets[0].midiNote).toBe(69); // 69+2=71 → クランプされ69のまま
  });
});

describe('recommend — M-4/M-5 clamp chaining (successive recommend() calls stay in-range)', () => {
  it('durationMs stays within [DURATION_MIN_MS, DURATION_MAX_MS] under repeated pitchStability recommendations', () => {
    let spec = SPEC;
    const diagnosis = makeDiagnosis({ primaryWeakness: 'pitchStability', rationale: 'normal:pitchStability' });
    for (let i = 0; i < 10; i++) {
      const result = makeResult({ metrics: { pitchStability: 0.1 }, spec });
      spec = recommend(diagnosis, result).spec;
      expect(spec.targets[0].durationMs).toBeGreaterThanOrEqual(800);
      expect(spec.targets[0].durationMs).toBeLessThanOrEqual(4000);
    }
  });

  it('durationMs stays within [DURATION_MIN_MS, DURATION_MAX_MS] under repeated attackAccuracy recommendations (shrinking)', () => {
    let spec = SPEC;
    const diagnosis = makeDiagnosis({ primaryWeakness: 'attackAccuracy', rationale: 'normal:attackAccuracy' });
    for (let i = 0; i < 10; i++) {
      const result = makeResult({ metrics: { attackAccuracy: 0.1 }, spec });
      spec = recommend(diagnosis, result).spec;
      expect(spec.targets[0].durationMs).toBeGreaterThanOrEqual(800);
      expect(spec.targets[0].durationMs).toBeLessThanOrEqual(4000);
    }
  });

  it('midiNote never drops below TOWARD_USER_MIDI_MIN(40) under repeated octaveOff=-1 recommendations (N-2)', () => {
    // レビューN-2の裁定により、「声域側へ寄せる」提案の下限は TARGET_MIDI_MIN(48)ではなく
    // TOWARD_USER_MIDI_MIN(40)。48でクランプすると低い声のユーザーへの提案が
    // 同一specに空振りし「あなたの声に合わせたお手本で」という文言と矛盾するため。
    let spec: ExerciseSpec = { ...SPEC, targets: [{ ...SPEC.targets[0], midiNote: 52 }] };
    const diagnosis = makeDiagnosis({ octaveOff: -1, primaryWeakness: null, rationale: 'octaveOff' });
    for (let i = 0; i < 3; i++) {
      const result = makeResult({ spec });
      spec = recommend(diagnosis, result).spec;
      expect(spec.targets[0].midiNote).toBeGreaterThanOrEqual(40);
    }
    expect(spec.targets[0].midiNote).toBe(40); // 52-12=40、40-12=28→clamp40、以降40のまま
  });

  it('reachTarget never rises more than +5 semitones above the original, and stays within TARGET_MIDI_MAX(69) (m-3)', () => {
    // original=67(TARGET_MIDI_MAXの69に近い)。voiced中央値は+15半音相当(82)を示唆するが、
    // まず±5にクランプされ72になり、さらにTARGET_MIDI_MAX(69)にクランプされる。
    const nearMaxSpec: ExerciseSpec = { ...SPEC, targets: [{ ...SPEC.targets[0], midiNote: 67 }] };
    const samples = [sample(82), sample(82), sample(82)];
    const result = makeResult({ spec: nearMaxSpec, samples });
    const diagnosis = makeDiagnosis({ primaryWeakness: null, rationale: 'reachTarget' });
    const { spec } = recommend(diagnosis, result);
    expect(spec.targets[0].midiNote).toBeLessThanOrEqual(67 + 5);
    expect(spec.targets[0].midiNote).toBeLessThanOrEqual(69);
    expect(spec.targets[0].midiNote).toBe(69);
  });
});

describe('recommend — attackAccuracy weak', () => {
  it('scales durationMs by 0.6x (short attack variant)', () => {
    const result = makeResult({ metrics: { attackAccuracy: 0.1 } });
    const diagnosis = makeDiagnosis({ primaryWeakness: 'attackAccuracy', rationale: 'normal:attackAccuracy' });
    const { spec, reasonKey } = recommend(diagnosis, result);
    expect(reasonKey).toBe('attackAccuracy');
    expect(spec.targets[0].durationMs).toBe(1800);
    expect(spec.targets[0].midiNote).toBe(60);
    expectRunnable(spec);
  });
});
