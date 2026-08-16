import { describe, expect, it } from 'vitest';
import { scoreExercise } from './score';
import { midiToHz } from '../pitch/conversions';
import { PARAMS_VERSION } from '../constants';
import type { ExerciseSpec, ProcessedPitchSample, Voicing } from '../types';

const HOP_MS = 10;
const TARGET_MIDI = 60; // C4

const SPEC: ExerciseSpec = {
  exerciseId: 'ex-level2-single-note',
  levelId: 'level2',
  targets: [{ midiNote: TARGET_MIDI, startMs: 0, durationMs: 3000 }],
  phonationMaxMs: 5000,
  guardAfterPlaybackMs: 250,
};

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

describe('scoreExercise — validity', () => {
  it('marks tooShort when voicedMs < 500ms', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 20, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 200ms < 500ms
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: false, reason: 'tooShort' });
  });

  // M-1再設計(レビュー): 旧ロジック(tooQuiet/unclearが全サンプルの30%以上)は廃止。
  // 新ロジックは「active区間(最初〜最後の非silentサンプルの間)内の tooQuiet+unclear
  // 合計時間 >= VALID_MIN_VOICED_MS(500ms)」で判定する(分母を録音全体にしない)。
  it('marks tooQuiet when tooQuiet/unclear time within the active window reaches VALID_MIN_VOICED_MS', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 50ms voiced (<500ms)
      { count: 40, midiNote: TARGET_MIDI, voicing: 'tooQuiet' }, // 400ms
      { count: 15, midiNote: TARGET_MIDI, voicing: 'unclear' }, // 150ms → tooQuiet+unclear合計550ms>=500ms
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: false, reason: 'tooQuiet' });
  });

  it('prefers tooQuiet over tooShort when both conditions hold simultaneously', () => {
    // voicedMs は 500ms 未満、かつ active区間内の tooQuiet 合計が500ms以上 → tooQuiet を優先
    const samples = buildTimeline([
      { count: 10, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 100ms
      { count: 60, midiNote: TARGET_MIDI, voicing: 'tooQuiet' }, // 600ms
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: false, reason: 'tooQuiet' });
  });

  it('M-1: does NOT count tooQuiet/unclear time outside the active window (leading silence does not dilute/inflate the judgement)', () => {
    // active区間外(先頭の silent)は tooQuiet/unclear 判定に一切寄与しない。
    // voiced 100ms + tooQuiet 350ms(active区間内合計450ms<500ms) → tooShort になるべき
    // (旧ロジックなら分母=全サンプルなので閾値の意味が変わってしまうケース)。
    const samples = buildTimeline([
      { count: 10, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 100ms
      { count: 35, midiNote: TARGET_MIDI, voicing: 'tooQuiet' }, // 350ms (合計450ms<500ms)
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: false, reason: 'tooShort' });
  });

  it('M-1 regression: validity is unaffected by a long silent lead-in before phonation starts ("発声前に10秒待つ")', () => {
    const voicedPortion: { count: number; midiNote: number; voicing?: Voicing }[] = [
      { count: 60, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 600ms >= VALID_MIN_VOICED_MS
    ];
    const withoutLeadIn = buildTimeline([...voicedPortion]);
    const withTenSecondLeadIn = buildTimeline([
      { count: 1000, midiNote: TARGET_MIDI, voicing: 'silent' }, // ~10s of silence before phonation
      ...voicedPortion,
    ]);

    const a = scoreExercise(withoutLeadIn, SPEC, 1000);
    const b = scoreExercise(withTenSecondLeadIn, SPEC, 1000);
    expect(a.validity).toEqual({ isValid: true, reason: 'ok' });
    expect(b.validity).toEqual(a.validity);
  });

  it('tooQuiet: active区間内にunclearが500ms以上(voicedなし)', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 55, midiNote: TARGET_MIDI, voicing: 'unclear' }, // 550ms >= 500ms
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: false, reason: 'tooQuiet' });
  });

  it('marks ok when voiced time is sufficient and tooQuiet/unclear stays under 30%', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 100, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 1000ms
    ]);
    const result = scoreExercise(samples, SPEC, 1000);
    expect(result.validity).toEqual({ isValid: true, reason: 'ok' });
    expect(result.paramsVersion).toBe(PARAMS_VERSION);
  });
});

describe('scoreExercise — ideal phonation', () => {
  it('scores near-perfect metrics for immediate, stable, on-target singing', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 100, midiNote: TARGET_MIDI, voicing: 'voiced' }, // exactly on target throughout
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.octaveOff).toBe(0);
    expect(result.metrics.pitchAccuracy).toBeCloseTo(1, 5);
    expect(result.metrics.medianAbsCents).toBeCloseTo(0, 5);
    expect(result.metrics.attackAccuracy).not.toBeNull();
    expect(result.metrics.attackAccuracy!).toBeCloseTo(1, 5); // 到達即時
    expect(result.metrics.pitchStability).not.toBeNull();
    expect(result.metrics.pitchStability!).toBeCloseTo(1, 5); // 分散ゼロ
  });
});

describe('scoreExercise — slow attack', () => {
  it('scores low attackAccuracy when the target is reached late, but high stability once locked in', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 150, midiNote: TARGET_MIDI + 5, voicing: 'voiced' }, // 1500ms off-target (+500cent)
      { count: 50, midiNote: TARGET_MIDI, voicing: 'voiced' }, // then locks on target
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    // onset=50ms, reach at 1550ms → t=1.5s → clamp(1-1.5/2,0,1)=0.25
    expect(result.metrics.attackAccuracy).not.toBeNull();
    expect(result.metrics.attackAccuracy!).toBeCloseTo(0.25, 5);
    expect(result.metrics.pitchStability).not.toBeNull();
    expect(result.metrics.pitchStability!).toBeCloseTo(1, 5); // 到達後は完全に安定
  });
});

describe('scoreExercise — instability after reaching target', () => {
  it('scores low pitchStability when pitch oscillates widely after an immediate reach', () => {
    const segments = [{ count: 5, midiNote: TARGET_MIDI, voicing: 'silent' as Voicing }];
    // 最初のvoicedサンプルで即座にonターゲット(高いattackAccuracy)、
    // その後 ±150cent(±1.5半音)で交互に振動させ、σ≈150cent(clampで0)にする
    const wobble: { count: number; midiNote: number; voicing?: Voicing }[] = [
      { count: 1, midiNote: TARGET_MIDI },
    ];
    for (let i = 0; i < 100; i++) {
      wobble.push({ count: 1, midiNote: i % 2 === 0 ? TARGET_MIDI + 1.5 : TARGET_MIDI - 1.5 });
    }
    const samples = buildTimeline([...segments, ...wobble]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.metrics.attackAccuracy).not.toBeNull();
    expect(result.metrics.attackAccuracy!).toBeCloseTo(1, 5); // 即到達
    expect(result.metrics.pitchStability).not.toBeNull();
    expect(result.metrics.pitchStability!).toBeCloseTo(0, 5); // σ150 > NORM100 → clampで0
  });
});

describe('scoreExercise — C-2: pitchStability requires >= STABILITY_MIN_MS of voiced time after reach', () => {
  it('single sample at reach (~10ms of stable voiced time) → pitchStability null (prevents σ=0 false praise)', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 50, midiNote: TARGET_MIDI + 4, voicing: 'voiced' }, // off-target, establishes onset only
      { count: 1, midiNote: TARGET_MIDI, voicing: 'voiced' }, // reaches target for exactly one sample, then recording ends
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.metrics.attackAccuracy).not.toBeNull(); // 到達自体はしている
    expect(result.metrics.pitchStability).toBeNull(); // 到達後の有声時間 ~10ms < STABILITY_MIN_MS(300ms)
  });

  it('~400ms elapsed since reach but only ~210ms of it is actually voiced (a tooQuiet gap in between) → pitchStability null', () => {
    // 到達からの経過時間(≈400ms)ではなく「到達後の voiced 時間の合計」で判定することを確認する
    // 回帰テスト。合間に tooQuiet の空白(150ms)を挟み、実質的な有声蓄積は210ms(<300ms)に留める。
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' }, // 0-40ms
      { count: 16, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 50-200ms: onset+即到達(reachIdx=先頭)
      { count: 15, midiNote: TARGET_MIDI, voicing: 'tooQuiet' }, // 210-350ms: 有声としてカウントしない
      { count: 5, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 360-400ms
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.metrics.attackAccuracy).not.toBeNull();
    expect(result.metrics.attackAccuracy!).toBeCloseTo(1, 5); // 即到達
    expect(result.metrics.pitchStability).toBeNull(); // 有声蓄積210ms < 300ms
  });

  it('~700ms of continuous voiced time after an immediate reach → pitchStability non-null', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 70, midiNote: TARGET_MIDI, voicing: 'voiced' }, // 700ms, on-target throughout
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.metrics.pitchStability).not.toBeNull();
    expect(result.metrics.pitchStability!).toBeCloseTo(1, 5); // σ=0
  });
});

describe('scoreExercise — octave-off, stable one octave below', () => {
  it('detects octaveOff=-1 and computes octave-corrected pitchAccuracy as high', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 100, midiNote: TARGET_MIDI - 12, voicing: 'voiced' }, // 1オクターブ下で安定
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.octaveOff).toBe(-1);
    // 補正後(cents+1200)は0となるため、pitchAccuracy/medianAbsCentsは補正後で高評価になる
    expect(result.metrics.pitchAccuracy).toBeCloseTo(1, 5);
    expect(result.metrics.medianAbsCents).toBeCloseTo(0, 5);
  });

  it('detects octaveOff=+1 for singing one octave above the target', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 100, midiNote: TARGET_MIDI + 12, voicing: 'voiced' },
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.octaveOff).toBe(1);
    expect(result.metrics.pitchAccuracy).toBeCloseTo(1, 5);
  });
});

describe('scoreExercise — target never reached', () => {
  it('leaves attackAccuracy and pitchStability null, with pitchAccuracy ≈ 0', () => {
    const samples = buildTimeline([
      { count: 5, midiNote: TARGET_MIDI, voicing: 'silent' },
      { count: 100, midiNote: TARGET_MIDI + 4, voicing: 'voiced' }, // +400cent、octaveOffにも該当しない
    ]);
    const result = scoreExercise(samples, SPEC, 1000);

    expect(result.octaveOff).toBe(0);
    expect(result.metrics.pitchAccuracy).toBe(0);
    expect(result.metrics.attackAccuracy).toBeNull();
    expect(result.metrics.pitchStability).toBeNull();
  });
});
