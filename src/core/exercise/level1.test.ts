// makeLevel1Trial / evaluateDirection のテスト。TRAINING_MODEL.md「Level 1: 音の上下」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateDirection, makeLevel1Trial } from './level1';
import type { ProcessedPitchSample, Voicing } from '../types';
import { midiToHz } from '../pitch/conversions';
import {
  L1_MAX_INTERVAL_SEMITONES,
  L1_MIN_INTERVAL_SEMITONES,
  L1_SEGMENT_MIN_VOICED_MS,
} from '../constants';

afterEach(() => {
  vi.restoreAllMocks();
});

// --- テスト用ヘルパー ---

const LOW_POOL = [48, 50, 52, 53, 55, 57]; // C3 D3 E3 F3 G3 A3(level1.ts内RANGE_SCALE_MIDI.lowと同値)
const HIGH_POOL = [57, 59, 60, 62, 64]; // A3 B3 C4 D4 E4

function isCMajor(midi: number): boolean {
  return [0, 2, 4, 5, 7, 9, 11].includes(((midi % 12) + 12) % 12);
}

/** タイムライン上に voiced/silent 区間を連結して ProcessedPitchSample[] を作る(evaluateDirection用)。
 * hopMs 間隔で連続するタイムスタンプを持ち、sampleDurationsMs の想定どおりに動く。 */
function buildTimeline(spec: Array<{ midi: number | null; count: number }>, hopMs = 12): ProcessedPitchSample[] {
  const out: ProcessedPitchSample[] = [];
  let t = 0;
  for (const seg of spec) {
    const voicing: Voicing = seg.midi !== null ? 'voiced' : 'silent';
    for (let i = 0; i < seg.count; i++) {
      const hz = seg.midi !== null ? midiToHz(seg.midi) : 0;
      out.push({
        sampleIndex: t,
        timestampMs: t,
        frequencyHzForScoring: hz,
        frequencyHzForDisplay: hz,
        midiNote: seg.midi ?? 0,
        voicing,
      });
      t += hopMs;
    }
  }
  return out;
}

describe('makeLevel1Trial', () => {
  it('same確率がヒットしたら B=A・direction=same を返す(1回目=A選択, 2回目=same判定ロール)', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
    const trial = makeLevel1Trial(null, 'low');
    expect(trial.aMidi).toBe(LOW_POOL[0]);
    expect(trial.bMidi).toBe(trial.aMidi);
    expect(trial.direction).toBe('same');
  });

  it('same確率を外れたら間隔制約内のBを選ぶ(A=50, up方向優先→53/55/57の先頭)', () => {
    // r1: aMidi選択(index1=50) / r2: same判定ロール(0.5>=0.2でスキップ) /
    // r3: 方向ロール(0.9>=0.5でup優先) / r4: 候補内選択(0→先頭)
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.2) // floor(0.2*6)=1 -> 50
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0);
    const trial = makeLevel1Trial(null, 'low');
    expect(trial.aMidi).toBe(50);
    expect(trial.direction).toBe('up');
    expect(trial.bMidi).toBe(53); // up候補=[53,55,57]の先頭(diff3/5/7)
    expect(trial.bMidi - trial.aMidi).toBeGreaterThanOrEqual(L1_MIN_INTERVAL_SEMITONES);
    expect(trial.bMidi - trial.aMidi).toBeLessThanOrEqual(L1_MAX_INTERVAL_SEMITONES);
  });

  it('優先方向に候補が無ければ反対方向へフォールバックする(A=48=プール最低音、down優先だが候補無し→up)', () => {
    // r1: aMidi選択(index0=48) / r2: same判定スキップ / r3: 方向ロール(down優先) / r4: 候補内選択(末尾)
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0) // -> 48
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.1) // <0.5 -> down優先
      .mockReturnValueOnce(0.999); // 候補配列の末尾を選択
    const trial = makeLevel1Trial(null, 'low');
    expect(trial.aMidi).toBe(48);
    // down方向は48が最低音のため候補ゼロ -> upへ反転。up候補=[52,53,55](diff4/5/7)
    expect(trial.direction).toBe('up');
    expect(trial.bMidi).toBe(55);
  });

  it('両方向とも候補が無い狭いcomfortRangeでは same にフォールバックする(実装判断)', () => {
    // comfortRange={60,64}のスケール音プール=[60,62,64]。A=62から±3〜7は両方向ともプール外。
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.4) // floor(0.4*3)=1 -> 62
      .mockReturnValueOnce(0.9) // same判定スキップ
      .mockReturnValueOnce(0.1); // 方向ロール(down優先) — どちらにせよ候補は無い
    const trial = makeLevel1Trial({ lowMidi: 60, highMidi: 64 }, 'low');
    expect(trial.aMidi).toBe(62);
    expect(trial.bMidi).toBe(62);
    expect(trial.direction).toBe('same');
  });

  it('comfortRangeが指定されればプリセットより優先して使われる(プリセットに無い音F4=65が選ばれる)', () => {
    // comfortRange={60,71}のスケール音プール=[60,62,64,65,67,69,71](7音)
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.45) // floor(0.45*7)=3 -> 65(F4。low/highどちらのプリセットにも無い)
      .mockReturnValueOnce(0); // same判定ヒットでB=Aに短絡(方向ロジックは他テストで検証済み)
    const trial = makeLevel1Trial({ lowMidi: 60, highMidi: 71 }, 'low');
    expect(trial.aMidi).toBe(65);
    expect(LOW_POOL).not.toContain(65);
    expect(HIGH_POOL).not.toContain(65);
  });

  it('comfortRangeがnull/空プールならプリセット(low/high)へフォールバックする', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const withNull = makeLevel1Trial(null, 'high');
    expect(HIGH_POOL).toContain(withNull.aMidi);

    // lowMidi > highMidi(壊れたsettings値の防御) — スケール音プールが空になりフォールバック
    const withBroken = makeLevel1Trial({ lowMidi: 68, highMidi: 60 }, 'high');
    expect(HIGH_POOL).toContain(withBroken.aMidi);
  });

  it('プロパティテスト(実乱数): 常にA/Bはスケール音・Bは同一かMIN〜MAX半音差以内', () => {
    for (let i = 0; i < 200; i++) {
      const trial = makeLevel1Trial(null, i % 2 === 0 ? 'low' : 'high');
      expect(isCMajor(trial.aMidi)).toBe(true);
      expect(isCMajor(trial.bMidi)).toBe(true);
      if (trial.bMidi === trial.aMidi) {
        expect(trial.direction).toBe('same');
      } else {
        const diff = Math.abs(trial.bMidi - trial.aMidi);
        expect(diff).toBeGreaterThanOrEqual(L1_MIN_INTERVAL_SEMITONES);
        expect(diff).toBeLessThanOrEqual(L1_MAX_INTERVAL_SEMITONES);
        expect(trial.direction).toBe(trial.bMidi > trial.aMidi ? 'up' : 'down');
      }
    }
  });
});

describe('evaluateDirection', () => {
  it('上がる: 2セグメントの中央値差が+50centを超えればup', () => {
    // 60(C4)->62(D4)は+200cent
    const processed = buildTimeline([
      { midi: 60, count: 30 }, // 360ms(>=300ms)
      { midi: null, count: 25 }, // 300ms無音(>=250msギャップ)
      { midi: 62, count: 30 },
    ]);
    const result = evaluateDirection(processed);
    expect(result.detected).toBe('up');
    expect(result.deltaCents).toBeCloseTo(200, 5);
    expect(result.segments).toBe(2);
  });

  it('下がる: 中央値差が-50cent未満ならdown', () => {
    const processed = buildTimeline([
      { midi: 64, count: 30 },
      { midi: null, count: 25 },
      { midi: 62, count: 30 }, // -200cent
    ]);
    const result = evaluateDirection(processed);
    expect(result.detected).toBe('down');
    expect(result.deltaCents).toBeCloseTo(-200, 5);
  });

  it('同じ: 境界ちょうど50centはsame(inclusive)', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 60.5, count: 30 }, // ちょうど+50cent
    ]);
    const result = evaluateDirection(processed);
    expect(result.deltaCents).toBeCloseTo(50, 5);
    expect(result.detected).toBe('same');
  });

  it('境界を1cent超えるとupに切り替わる', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 60.51, count: 30 }, // +51cent
    ]);
    const result = evaluateDirection(processed);
    expect(result.detected).toBe('up');
  });

  it('境界を下側に1cent超えるとdownに切り替わる', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 59.49, count: 30 }, // -51cent
    ]);
    const result = evaluateDirection(processed);
    expect(result.detected).toBe('down');
  });

  it('セグメント分割: ギャップがL1_SEGMENT_GAP_MS未満なら分割せず1セグメントに統合する(2セグメント未満→null)', () => {
    const processed = buildTimeline([
      { midi: 60, count: 15 }, // 180ms
      { midi: null, count: 8 }, // 96ms(<250msギャップ閾値 — 分割しない)
      { midi: 60, count: 15 }, // 180ms(統合後、合計360ms>=300ms=有効1セグメント)
    ]);
    const result = evaluateDirection(processed);
    expect(result.segments).toBe(1); // 統合されて1セグメントのみ
    expect(result.detected).toBeNull();
    expect(result.deltaCents).toBeNull();
  });

  it('短すぎるセグメントは除外される(有声合計<300msのセグメントは数えない)', () => {
    const processed = buildTimeline([
      { midi: 60, count: 10 }, // 120ms(<300ms -> 除外)
      { midi: null, count: 25 }, // 300ms(分割)
      { midi: 60, count: 30 }, // 360ms(有効1つ目)
      { midi: null, count: 25 }, // 分割
      { midi: 64, count: 30 }, // 360ms(有効2つ目, +400cent -> up)
    ]);
    const result = evaluateDirection(processed);
    expect(result.segments).toBe(2); // 短い先頭セグメントは数えない
    expect(result.detected).toBe('up');
  });

  it('有効セグメントが1つだけなら測定不能(detected=null)', () => {
    const processed = buildTimeline([{ midi: 60, count: 30 }]);
    const result = evaluateDirection(processed);
    expect(result.segments).toBe(1);
    expect(result.detected).toBeNull();
    expect(result.deltaCents).toBeNull();
  });

  it('voicedサンプルが1件も無ければ測定不能', () => {
    const processed = buildTimeline([{ midi: null, count: 40 }]);
    const result = evaluateDirection(processed);
    expect(result.segments).toBe(0);
    expect(result.detected).toBeNull();
  });

  it('境界ちょうどL1_SEGMENT_MIN_VOICED_MSのセグメントは有効に数える(inclusive)', () => {
    // hopMs=12, count=25 -> 300ms ちょうど(L1_SEGMENT_MIN_VOICED_MS=300)
    const exactCount = L1_SEGMENT_MIN_VOICED_MS / 12;
    const processed = buildTimeline([
      { midi: 60, count: exactCount },
      { midi: null, count: 25 },
      { midi: 62, count: exactCount },
    ]);
    const result = evaluateDirection(processed);
    expect(result.segments).toBe(2);
    expect(result.detected).toBe('up');
  });
});
