import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose';
import type { Diagnosis, ExerciseMetrics, ExerciseResult, ExerciseSpec } from '../types';

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

function makeResult(overrides: {
  isValid?: boolean;
  reason?: ExerciseResult['validity']['reason'];
  octaveOff?: -1 | 0 | 1;
  metrics?: Partial<ExerciseMetrics>;
}): ExerciseResult {
  return {
    spec: SPEC,
    timestamp: 1000,
    paramsVersion: 1,
    validity: { isValid: overrides.isValid ?? true, reason: overrides.reason ?? 'ok' },
    metrics: { ...GOOD_METRICS, ...overrides.metrics },
    octaveOff: overrides.octaveOff ?? 0,
    samples: [],
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

describe('diagnose — step 1: validity', () => {
  it('returns primaryWeakness=null with invalid:tooShort rationale', () => {
    const result = makeResult({ isValid: false, reason: 'tooShort' });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.rationale).toBe('invalid:tooShort');
    expect(d.isReliable).toBe(true);
  });

  it('returns primaryWeakness=null with invalid:tooQuiet rationale', () => {
    const result = makeResult({ isValid: false, reason: 'tooQuiet' });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.rationale).toBe('invalid:tooQuiet');
  });

  it('takes priority over octaveOff and metrics even when both are set', () => {
    const result = makeResult({
      isValid: false,
      reason: 'tooShort',
      octaveOff: 1,
      metrics: { pitchAccuracy: 0, attackAccuracy: null, pitchStability: null },
    });
    const d = diagnose(result, []);
    expect(d.rationale).toBe('invalid:tooShort');
    expect(d.primaryWeakness).toBeNull();
  });
});

describe('diagnose — step 2: octaveOff', () => {
  it('propagates octaveOff=+1 with primaryWeakness=null and rationale=octaveOff', () => {
    const result = makeResult({ octaveOff: 1 });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.octaveOff).toBe(1);
    expect(d.rationale).toBe('octaveOff');
  });

  it('propagates octaveOff=-1', () => {
    const result = makeResult({ octaveOff: -1 });
    const d = diagnose(result, []);
    expect(d.octaveOff).toBe(-1);
    expect(d.rationale).toBe('octaveOff');
  });

  it('takes priority over the normal weakness-detection branch', () => {
    const result = makeResult({
      octaveOff: 1,
      metrics: { pitchAccuracy: 0.1, pitchStability: 0.1, attackAccuracy: 0.1 },
    });
    const d = diagnose(result, []);
    expect(d.rationale).toBe('octaveOff');
    expect(d.primaryWeakness).toBeNull();
  });
});

describe('diagnose — step 3: reachTarget', () => {
  it('returns rationale=reachTarget when pitchAccuracy≈0 and attack/stability are null', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.02, attackAccuracy: null, pitchStability: null },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.rationale).toBe('reachTarget');
    expect(d.isReliable).toBe(true);
  });

  it('C-3: fires reachTarget purely on pitchAccuracy, even when attack/stability are non-null (spec revised)', () => {
    // レビューC-3: 旧仕様は「attack/stabilityがnullの場合のみ」発火していたが、それだと
    // 一瞬±50centをかすっただけで到達不能ケースから外れてしまう。新仕様は
    // pitchAccuracy < REACH_TARGET_ACCURACY 単独で判定する。
    const result = makeResult({
      metrics: { pitchAccuracy: 0.02, attackAccuracy: 0.5, pitchStability: 0.5 },
    });
    const d = diagnose(result, []);
    expect(d.rationale).toBe('reachTarget');
    expect(d.primaryWeakness).toBeNull();
  });

  it('C-3再現ケース: pitchAccuracy=0.04・attackAccuracy=0(4.6秒到達)・stability非null でも reachTarget になる', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.04, attackAccuracy: 0, pitchStability: 0.5 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.rationale).toBe('reachTarget');
    expect(d.isReliable).toBe(true);
  });
});

describe('diagnose — step 3b: allGood (m-8)', () => {
  it('returns primaryWeakness=null / rationale=allGood when every non-null metric is in the top band', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.8, pitchStability: 0.75, attackAccuracy: 0.85 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBeNull();
    expect(d.rationale).toBe('allGood');
    expect(d.isReliable).toBe(true);
  });

  it('does not fire allGood when at least one non-null metric is below the top band', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.8, pitchStability: 0.5, attackAccuracy: 0.85 },
    });
    const d = diagnose(result, []);
    expect(d.rationale).not.toBe('allGood');
  });

  it('allGood still applies when some metrics are null (e.g. pitchStability never reached-stable-long-enough), as long as the non-null ones are all top band', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.9, pitchStability: null, attackAccuracy: 0.85 },
    });
    const d = diagnose(result, []);
    expect(d.rationale).toBe('allGood');
    expect(d.primaryWeakness).toBeNull();
  });
});

describe('diagnose — step 4: band-based selection (no history)', () => {
  it('picks the metric in the lowest (worst) band', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.9, pitchStability: 0.1, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBe('pitchStability');
    expect(d.isReliable).toBe(true);
  });

  it('breaks a same-band tie by picking the value closest to the band lower bound', () => {
    // pitchAccuracy=0.35 (初級, dist=0.35) vs pitchStability=0.05 (初級, dist=0.05)
    // pitchStabilityの方が下限に近い(より深く弱い)ので優先される
    const result = makeResult({
      metrics: { pitchAccuracy: 0.35, pitchStability: 0.05, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBe('pitchStability');
  });

  it('ignores null metrics and only compares non-null ones', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.6, pitchStability: null, attackAccuracy: 0.2 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBe('attackAccuracy');
  });

  it('M-2: breaks a same-band tie by normalized band position, not raw distance from the band lower bound', () => {
    // stability=0.28 (band[0.3,0.7) → 初級, 正規化位置=0.28/0.3≈0.933)
    // accuracy=0.30  (band[0.4,0.75) → 初級, 正規化位置=0.30/0.4=0.75)  ← より小さい=より弱い
    // 生値距離(旧実装)なら 0.28 < 0.30 で pitchStability が誤って選ばれてしまう。
    const result = makeResult({
      metrics: { pitchAccuracy: 0.3, pitchStability: 0.28, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBe('pitchAccuracy');
  });
});

describe('diagnose — step 5: hysteresis', () => {
  it('keeps the same weakness with isReliable=true when the candidate matches the previous one', () => {
    const history = [makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' })];
    const result = makeResult({
      metrics: { pitchAccuracy: 0.2, pitchStability: 0.9, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, history);
    expect(d.primaryWeakness).toBe('pitchAccuracy');
    expect(d.isReliable).toBe(true);
  });

  it('holds the previous weakness with isReliable=false on a single, non-margin switch attempt', () => {
    const history = [makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' })];
    // candidate=pitchStability(中級寄りの弱め値)。前回rawもpitchAccuracyなので2連続でもなく、
    // pitchAccuracy(GOOD=0.9→上級)からのバンド差も判定できるが、あえて僅差(1段未満)にする
    const result = makeResult({
      metrics: { pitchAccuracy: 0.5, pitchStability: 0.35, attackAccuracy: 0.9 },
      // pitchAccuracy=0.5→中級, pitchStability=0.35→中級 (同バンド帯、最弱はpitchStability)
      // 前回weakness=pitchAccuracyの今回値0.5→中級。candidate(pitchStability)も中級 → margin未達
    });
    const d = diagnose(result, history);
    expect(d.primaryWeakness).toBe('pitchAccuracy'); // 前回を維持
    expect(d.isReliable).toBe(false);
  });

  it('switches when the new candidate was already detected 2 sessions in a row (via held state)', () => {
    const history = [
      makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' }),
      makeDiagnosis({
        primaryWeakness: 'pitchAccuracy',
        rationale: 'normal:pitchStability:held',
        isReliable: false,
      }),
    ];
    // 今回もcandidate=pitchStability(2回連続で検出) → 切替を許可
    const result = makeResult({
      metrics: { pitchAccuracy: 0.5, pitchStability: 0.35, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, history);
    expect(d.primaryWeakness).toBe('pitchStability');
    expect(d.isReliable).toBe(true);
  });

  it('switches immediately when the new candidate band is at least one full band lower', () => {
    const history = [makeDiagnosis({ primaryWeakness: 'attackAccuracy', rationale: 'normal:attackAccuracy' })];
    const result = makeResult({
      // 前回weaknessだったattackAccuracyは今回0.9(上級)まで改善、pitchStabilityは0.1(初級)へ急落
      // 上級→初級は2段差 → margin条件(1段以上)を満たすため即切替
      metrics: { pitchAccuracy: 0.9, pitchStability: 0.1, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, history);
    expect(d.primaryWeakness).toBe('pitchStability');
    expect(d.isReliable).toBe(true);
  });

  it('M-3: an intervening invalid session does not erase hysteresis (A→A→invalid→B holds A, isReliable=false)', () => {
    const history = [
      makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' }), // session1: A
      makeDiagnosis({ primaryWeakness: 'pitchAccuracy', rationale: 'normal:pitchAccuracy' }), // session2: A
      makeDiagnosis({ primaryWeakness: null, rationale: 'invalid:tooShort' }), // session3: invalid
    ];
    // session4: candidate=pitchStability(B)の1回目。旧実装(直近1件参照)ならprevWeakness=null
    // (session3のprimaryWeakness)になり即切替してしまうが、レビューM-3の修正では
    // primaryWeaknessが非nullのsession2まで遡って参照するため、Aが維持されなければならない。
    const result = makeResult({
      metrics: { pitchAccuracy: 0.5, pitchStability: 0.35, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, history);
    expect(d.primaryWeakness).toBe('pitchAccuracy'); // 前回(session2)のAを維持
    expect(d.isReliable).toBe(false);
  });

  it('accepts the first-ever candidate as reliable when history is empty', () => {
    const result = makeResult({
      metrics: { pitchAccuracy: 0.9, pitchStability: 0.1, attackAccuracy: 0.9 },
    });
    const d = diagnose(result, []);
    expect(d.primaryWeakness).toBe('pitchStability');
    expect(d.isReliable).toBe(true);
  });
});
