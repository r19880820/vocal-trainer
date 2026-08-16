// ExerciseEngine の状態機械テスト(レビューM-10)。
// engine.ts 自体は変更禁止(Fable改訂済み)— ここではその契約をテストする。
// fake の ExerciseAudioPort(RawPitchSample列をスクリプト再生できるモック)+ fake callbacks +
// vi.useFakeTimers を使い、実際の PitchProcessor / scoreExercise / diagnose / recommend を
// 通した統合テストとして状態遷移を検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExerciseEngine } from './engine';
import type {
  EngineCallbacks,
  EngineState,
  ExerciseAudioPort,
  ExerciseOutcome,
  LiveDisplay,
} from './engine';
import type { ExerciseSpec, RawPitchSample } from '../types';

// ---------------------------------------------------------------------------
// テスト用 ExerciseSpec(Level 2, 1音合わせ)。
// ---------------------------------------------------------------------------
const SPEC: ExerciseSpec = {
  exerciseId: 'ex-level2-single-note',
  levelId: 'level2',
  targets: [{ midiNote: 60, startMs: 0, durationMs: 1500 }],
  phonationMaxMs: 5000,
  guardAfterPlaybackMs: 250,
};

// ---------------------------------------------------------------------------
// RawPitchSample 生成ヘルパー: timestampMs を10.7ms刻みで進める(実ホップ相当)。
// ---------------------------------------------------------------------------
const HOP_STEP_MS = 10.7;

class SampleClock {
  private sampleIndex = 0;
  private timestampMs = 0;

  next(overrides: Partial<RawPitchSample> = {}): RawPitchSample {
    this.sampleIndex += 1;
    this.timestampMs += HOP_STEP_MS;
    return {
      sampleIndex: this.sampleIndex,
      timestampMs: this.timestampMs,
      frequencyHz: 0,
      belowThreshold: false,
      confidence: 0,
      amplitude: 0.0001, // 静か(=calibration/silence用のデフォルト)
      ...overrides,
    };
  }

  /** voiced: 220Hz・belowThreshold=true・amplitude大 */
  voiced(): RawPitchSample {
    return this.next({ frequencyHz: 220, belowThreshold: true, confidence: 0.9, amplitude: 0.05 });
  }

  /** silent: amplitude極小(noiseFloor設定後は 'silent' 判定になる) */
  silent(): RawPitchSample {
    return this.next({ frequencyHz: 0, belowThreshold: false, confidence: 0, amplitude: 0.0001 });
  }

  /** 完全無音(amplitude=0厳密。m-5テスト用: rmsToDb(0)=-Infinityで有限dB扱いされない) */
  perfectSilence(): RawPitchSample {
    return this.next({ frequencyHz: 0, belowThreshold: false, confidence: 0, amplitude: 0 });
  }
}

// ---------------------------------------------------------------------------
// Fake ExerciseAudioPort: RawPitchSample を手動で push でき、playTone の resolve を
// テストから制御できる。
// ---------------------------------------------------------------------------
class FakePort implements ExerciseAudioPort {
  running = false;
  stopCalls = 0;
  playToneCalls: Array<{ hz: number; durationMs: number }> = [];
  private onRawCb: ((s: RawPitchSample) => void) | null = null;
  private onErrorCb: ((m: string) => void) | null = null;
  private playToneResolvers: Array<() => void> = [];

  async start(
    onRaw: (s: RawPitchSample) => void,
    onError: (m: string) => void
  ): Promise<{ internalSampleRate: number }> {
    this.onRawCb = onRaw;
    this.onErrorCb = onError;
    this.running = true;
    return { internalSampleRate: 24000 };
  }

  stop(): void {
    this.running = false;
    this.stopCalls += 1;
  }

  playTone(hz: number, durationMs: number): Promise<void> {
    this.playToneCalls.push({ hz, durationMs });
    return new Promise<void>((resolve) => {
      this.playToneResolvers.push(resolve);
    });
  }

  /** テストから「お手本再生が鳴り終わった」ことを明示的に発生させる。 */
  resolveNextPlayTone(): void {
    const r = this.playToneResolvers.shift();
    if (r) r();
  }

  push(sample: RawPitchSample): void {
    this.onRawCb?.(sample);
  }

  emitError(m: string): void {
    this.onErrorCb?.(m);
  }
}

function makeCallbacks() {
  const states: EngineState[] = [];
  const lives: LiveDisplay[] = [];
  const levels: number[] = [];
  const results: ExerciseOutcome[] = [];
  const errors: string[] = [];
  const cb: EngineCallbacks = {
    onState: (s) => states.push(s),
    onLive: (d) => lives.push(d),
    onLevel: (db) => levels.push(db),
    onResult: (o) => results.push(o),
    onError: (m) => errors.push(m),
  };
  return { cb, states, lives, levels, results, errors };
}

/** Promise マイクロタスクキューをフラッシュする(fake timers は Promise には無関係)。 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function setupEngine(spec: ExerciseSpec = SPEC) {
  const port = new FakePort();
  const { cb, states, lives, levels, results, errors } = makeCallbacks();
  const clock = { ms: 0 };
  const now = () => clock.ms;
  const advance = (ms: number) => {
    clock.ms += ms;
    vi.advanceTimersByTime(ms);
  };
  const engine = new ExerciseEngine(port, cb, now);
  return { port, cb, states, lives, levels, results, errors, clock, advance, engine, spec };
}

/** calibration(500ms分の静かなサンプル)を供給し、tooNoisyに倒れないことを前提にする。 */
function feedCalibration(port: FakePort, sc: SampleClock, count = 60): void {
  for (let i = 0; i < count; i++) {
    port.push(sc.next({ amplitude: 0.0001 }));
  }
}

/** beginExercise → calibrating完了 → playingReference → guard経過 → listening まで進める。 */
async function reachListening(
  ctx: ReturnType<typeof setupEngine>,
  sc: SampleClock
): Promise<void> {
  const { engine, port, advance, spec } = ctx;
  await engine.beginExercise(spec);
  expect(engine.getState()).toBe('calibrating');

  feedCalibration(port, sc);
  expect(engine.getState()).toBe('playingReference');
  expect(port.playToneCalls.length).toBe(1);

  port.resolveNextPlayTone();
  await flushMicrotasks();
  advance(spec.guardAfterPlaybackMs);
  expect(engine.getState()).toBe('listening');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExerciseEngine — normal flow', () => {
  it('calibrating → playingReference → listening → phonating → scoring → result (onResult fires)', async () => {
    const ctx = setupEngine();
    const { engine, port, states, results } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // onset: voiced連続150ms以上。1本目のtimestampMsが起点(voicedRunStartMs)になるため、
    // 150ms到達には16本必要(15区間 * 10.7ms = 160.5ms >= 150ms)。
    for (let i = 0; i < 16; i++) {
      port.push(sc.voiced());
    }
    expect(engine.getState()).toBe('phonating');

    // voiced 1秒分継続
    for (let i = 0; i < 93; i++) {
      // 93 * 10.7ms ≈ 995ms
      port.push(sc.voiced());
    }
    expect(engine.getState()).toBe('phonating');

    // 無音500ms超(voicedAccumMsは十分 >= VALID_MIN_VOICED_MS なのでそのままscoringへ)
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) {
      port.push(sc.silent());
    }

    expect(states).toContain('scoring');
    expect(states).toContain('result');
    expect(engine.getState()).toBe('result');
    expect(results.length).toBe(1);
    expect(results[0].result.validity).toBeDefined();
    expect(results[0].diagnosis).toBeDefined();
    expect(results[0].next.spec).toBeDefined();
  });
});

describe('ExerciseEngine — C-4 regression: short voiced burst after onset returns to listening (not scoring)', () => {
  it('onset → 200ms voiced total → 500ms silence → listening (not scoring); then 600ms voiced → 500ms silence → scoring', async () => {
    const ctx = setupEngine();
    const { engine, port, states, results } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // onset(150ms)+少し(合計200ms程度): voicedAccumMs < VALID_MIN_VOICED_MS(500ms)にとどめる
    for (let i = 0; i < 19; i++) {
      // 19 * 10.7 ≈ 203ms
      port.push(sc.voiced());
    }
    expect(engine.getState()).toBe('phonating');

    const stateCountBeforeSilence = states.length;
    // 無音500ms超
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) {
      port.push(sc.silent());
    }

    // scoringには行かず listening に戻る(C-4)
    expect(engine.getState()).toBe('listening');
    expect(states.slice(stateCountBeforeSilence)).not.toContain('scoring');
    expect(results.length).toBe(0);

    // あらためて600ms発声 → 500ms無音 → 今度はscoringに到達する
    for (let i = 0; i < 57; i++) {
      // 57 * 10.7 ≈ 610ms(onset150ms込み)
      port.push(sc.voiced());
    }
    expect(engine.getState()).toBe('phonating');

    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) {
      port.push(sc.silent());
    }

    expect(engine.getState()).toBe('result');
    expect(results.length).toBe(1);
  });
});

describe('ExerciseEngine — N-1 regression: repeated short bursts do not loop forever', () => {
  it('2nd short voiced burst → scoring (tooShort advice) instead of returning to listening again', async () => {
    const ctx = setupEngine();
    const { engine, port, results } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // 1回目の短発声(~200ms)→ 無音500ms → listening復帰(C-4の1回分は許容)
    for (let i = 0; i < 19; i++) port.push(sc.voiced());
    expect(engine.getState()).toBe('phonating');
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) port.push(sc.silent());
    expect(engine.getState()).toBe('listening');
    expect(results.length).toBe(0);

    // 2回目の短発声(~200ms)→ 無音500ms → 今度は採点される(無限往復しない)
    for (let i = 0; i < 19; i++) port.push(sc.voiced());
    expect(engine.getState()).toBe('phonating');
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) port.push(sc.silent());

    expect(engine.getState()).toBe('result');
    expect(results.length).toBe(1);
    // 短い発声なので tooShort(「声を伸ばす長さ」の正しい案内が出る経路)
    expect(results[0].result.validity.isValid).toBe(false);
    expect(results[0].result.validity.reason).toBe('tooShort');
  });

  it('shortRetryCount resets per reference playback: retry after result allows one short-burst grace again', async () => {
    const ctx = setupEngine();
    const { engine, port, results } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // 2回の短発声で1回目の採点(tooShort)へ
    for (let i = 0; i < 19; i++) port.push(sc.voiced());
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) port.push(sc.silent());
    for (let i = 0; i < 19; i++) port.push(sc.voiced());
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) port.push(sc.silent());
    expect(results.length).toBe(1);

    // retry(同一spec)→ 再びお手本 → listening。短発声1回目はまた listening 復帰になる(カウンタリセット)
    engine.retry();
    await flushMicrotasks();
    expect(engine.getState()).toBe('playingReference');
    port.resolveNextPlayTone();
    await flushMicrotasks();
    ctx.advance(ctx.spec.guardAfterPlaybackMs);
    expect(engine.getState()).toBe('listening');

    for (let i = 0; i < 19; i++) port.push(sc.voiced());
    expect(engine.getState()).toBe('phonating');
    for (let i = 0; i < 50 && engine.getState() === 'phonating'; i++) port.push(sc.silent());
    expect(engine.getState()).toBe('listening');
    expect(results.length).toBe(1); // まだ2回目の採点は起きない
  });
});

describe('ExerciseEngine — listening timeout', () => {
  it('10 seconds of continuous silence in listening → listenTimeout', async () => {
    const ctx = setupEngine();
    const { engine, port, advance, states } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // watchdog(4秒無音でトリップ)を回避しつつ、1秒刻みでsilentサンプルを送り続け10秒超過させる。
    for (let i = 0; i < 12 && engine.getState() === 'listening'; i++) {
      port.push(sc.silent());
      advance(1000);
    }

    expect(engine.getState()).toBe('listenTimeout');
    expect(states).toContain('listenTimeout');
  });

  it('m-12: voicing starting just before the 10s deadline extends the timeout instead of firing it', async () => {
    const ctx = setupEngine();
    const { engine, port, advance, states } = ctx;
    const sc = new SampleClock();

    await reachListening(ctx, sc);

    // 9.9秒目まで無音(watchdogを回避しつつ1秒刻みで進める)
    for (let i = 0; i < 9; i++) {
      port.push(sc.silent());
      advance(1000);
    }
    advance(900); // 累計9900ms
    expect(engine.getState()).toBe('listening');

    // ここから voiced を出し始める(元の10000ms締切をまたぐ)。
    // onset完了(150ms)まで20サンプル(20*10.7≈214ms)push、都度wall-clockも同じだけ進める。
    for (let i = 0; i < 20; i++) {
      port.push(sc.voiced());
      advance(HOP_STEP_MS);
    }

    // 元の締切(10000ms)をまたいでも listenTimeout にはならず、
    // 延長(m-12)により onset が完了して phonating まで進んでいるはず。
    expect(states).not.toContain('listenTimeout');
    expect(engine.getState()).toBe('phonating');
  });
});

describe('ExerciseEngine — m-5: fully silent calibration (amplitude=0 only) does not trigger tooNoisy', () => {
  it('proceeds calibrating → playingReference without ever entering tooNoisy', async () => {
    const ctx = setupEngine();
    const { engine, port, states } = ctx;
    const sc = new SampleClock();

    await engine.beginExercise(ctx.spec);
    expect(engine.getState()).toBe('calibrating');

    // amplitude=0 厳密(rmsToDb→-Infinity→Number.isFinite=false→calibDbsに積まれない)
    for (let i = 0; i < 60; i++) {
      port.push(sc.perfectSilence());
    }

    expect(engine.getState()).toBe('playingReference');
    expect(states).not.toContain('tooNoisy');
  });
});

describe('ExerciseEngine — M-8: watchdog', () => {
  it('no raw samples for > 4s while active → onError + idle (cancel calls port.stop())', async () => {
    const ctx = setupEngine();
    const { engine, port, advance, errors } = ctx;

    await engine.beginExercise(ctx.spec);
    expect(engine.getState()).toBe('calibrating');

    // watchdogチェックは2秒周期。6秒分進めれば「4秒超の無音」を確実に検知する。
    advance(6001);

    expect(errors.length).toBeGreaterThan(0);
    expect(engine.getState()).toBe('idle');
    expect(port.stopCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('ExerciseEngine — cancel()', () => {
  it('calls port.stop() and transitions to idle', async () => {
    const ctx = setupEngine();
    const { engine, port } = ctx;

    await engine.beginExercise(ctx.spec);
    expect(engine.getState()).toBe('calibrating');

    engine.cancel();

    expect(port.stopCalls).toBe(1);
    expect(engine.getState()).toBe('idle');
  });
});
