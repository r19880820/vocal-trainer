// makeLevel3Trial / evaluateLevel3 のテスト。TRAINING_MODEL.md「Level 3: 2音模倣」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateLevel3, makeLevel3Trial } from './level3';
import type { ProcessedPitchSample, Voicing } from '../types';
import { midiToHz } from '../pitch/conversions';
import { DIRECTION_SAME_CENTS, INTERVAL_NORM_CENTS, L1_SEGMENT_MIN_VOICED_MS, L3_INTERVAL_OK_CENTS } from '../constants';

afterEach(() => {
  vi.restoreAllMocks();
});

// --- テスト用ヘルパー(level1.test.tsと同型。level1.ts内RANGE_SCALE_MIDIと同値) ---

const LOW_POOL = [48, 50, 52, 53, 55, 57]; // C3 D3 E3 F3 G3 A3
const HIGH_POOL = [57, 59, 60, 62, 64]; // A3 B3 C4 D4 E4

function isCMajor(midi: number): boolean {
  return [0, 2, 4, 5, 7, 9, 11].includes(((midi % 12) + 12) % 12);
}

/** タイムライン上に voiced/silent 区間を連結して ProcessedPitchSample[] を作る(level1.test.tsと同型)。 */
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

describe('makeLevel3Trial', () => {
  it('same確率が無いため、B=Aには決してならない(方向ロール→A選択→候補選択)', () => {
    // r1: 方向ロール(0.9>=0.5でup優先) / r2: aMidi選択(index1=50) / r3: 候補内選択(0→先頭)
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.9).mockReturnValueOnce(0.2).mockReturnValueOnce(0);
    const trial = makeLevel3Trial(null, 'low');
    expect(trial.aMidi).toBe(50);
    expect(trial.bMidi).toBe(53); // up候補=[53,55,57]の先頭(diff3/5/7)
    expect(trial.aMidi).not.toBe(trial.bMidi);
  });

  it('優先方向に候補が無ければ反対方向へフォールバックする(A=48=プール最低音、down優先だが候補無し→up)', () => {
    // r1: 方向ロール(down優先) / r2: aMidi選択(index0=48) / r3: 候補内選択(末尾)
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const trial = makeLevel3Trial(null, 'low');
    expect(trial.aMidi).toBe(48);
    expect(trial.bMidi).toBe(55); // down候補ゼロ→up候補=[52,53,55]の末尾
  });

  it('comfortRangeが指定されればプリセットより優先して使われる(プリセットに無い音F4=65が選ばれる)', () => {
    // comfortRange={60,71}のスケール音プール=[60,62,64,65,67,69,71](7音)
    // r1: 方向ロール(down優先) / r2: aMidi選択(index3=65) / r3: 候補内選択(先頭)
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.45).mockReturnValueOnce(0);
    const trial = makeLevel3Trial({ lowMidi: 60, highMidi: 71 }, 'low');
    expect(trial.aMidi).toBe(65); // F4。low/highどちらのプリセットにも無い
    expect(LOW_POOL).not.toContain(65);
    expect(HIGH_POOL).not.toContain(65);
    expect(trial.aMidi).not.toBe(trial.bMidi);
  });

  it('両方向とも候補が無い狭いcomfortRangeでは same を出題せずプリセットプールへフォールバックする', () => {
    // comfortRange={60,64}のスケール音プール=[60,62,64]。A=62から±3〜7は両方向ともプール外
    // (level1.test.tsで same フォールバックが確認済みの同型ケース)。
    // r1: 方向ロール(down優先) / r2: primaryAMidi選択(index1=62、候補なし) /
    // r3: presetAMidi選択(low pool index1=50) / r4: 候補内選択(先頭)
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1) // down優先
      .mockReturnValueOnce(0.4) // floor(0.4*3)=1 -> 62
      .mockReturnValueOnce(0.2) // floor(0.2*6)=1 -> 50(LOW_POOLへフォールバック)
      .mockReturnValueOnce(0); // 候補内選択(先頭)
    const trial = makeLevel3Trial({ lowMidi: 60, highMidi: 64 }, 'low');
    // 50からdown候補は無い(48との差が2半音)ため反対方向(up)へ反転 -> 候補=[53,55,57]の先頭
    expect(trial.aMidi).toBe(50);
    expect(trial.bMidi).toBe(53);
    expect(trial.aMidi).not.toBe(trial.bMidi);
  });

  it('comfortRangeがnull/空プールならプリセット(low/high)へフォールバックする', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // 常にdown優先・先頭選択
    const withNull = makeLevel3Trial(null, 'high');
    expect(HIGH_POOL).toContain(withNull.aMidi);

    // lowMidi > highMidi(壊れたsettings値の防御) — スケール音プールが空になりフォールバック
    const withBroken = makeLevel3Trial({ lowMidi: 68, highMidi: 60 }, 'high');
    expect(HIGH_POOL).toContain(withBroken.aMidi);
  });

  it('プロパティテスト(実乱数): 常にA/Bはスケール音・same無し・MIN〜MAX半音差以内(通常プール)', () => {
    for (let i = 0; i < 200; i++) {
      const trial = makeLevel3Trial(null, i % 2 === 0 ? 'low' : 'high');
      expect(isCMajor(trial.aMidi)).toBe(true);
      expect(isCMajor(trial.bMidi)).toBe(true);
      expect(trial.aMidi).not.toBe(trial.bMidi);
      const diff = Math.abs(trial.bMidi - trial.aMidi);
      expect(diff).toBeGreaterThanOrEqual(3);
      expect(diff).toBeLessThanOrEqual(7);
    }
  });

  it('プロパティテスト(実乱数): 両方向候補ゼロになりうる狭いcomfortRangeでもsame無し・間隔制約内', () => {
    for (let i = 0; i < 100; i++) {
      const trial = makeLevel3Trial({ lowMidi: 60, highMidi: 64 }, i % 2 === 0 ? 'low' : 'high');
      expect(trial.aMidi).not.toBe(trial.bMidi);
      const diff = Math.abs(trial.bMidi - trial.aMidi);
      expect(diff).toBeGreaterThanOrEqual(3);
      expect(diff).toBeLessThanOrEqual(7);
    }
  });
});

describe('evaluateLevel3', () => {
  const trialUp = { aMidi: 60, bMidi: 64 }; // C4->E4, +400cent
  const trialDown = { aMidi: 64, bMidi: 60 }; // E4->C4, -400cent

  it('測定不能: 有効セグメントが1つだけ・フォールバックも不足なら measured=false で全フィールドnull', () => {
    const processed = buildTimeline([{ midi: 60, count: 30 }]); // 360ms、1セグメントのみ
    const result = evaluateLevel3(processed, trialUp);
    expect(result.measured).toBe(false);
    expect(result.firstNoteCents).toBeNull();
    expect(result.secondNoteCents).toBeNull();
    expect(result.userIntervalCents).toBeNull();
    expect(result.intervalAccuracy).toBeNull();
    expect(result.directionOk).toBeNull();
    expect(result.feedback).toBeNull();
    expect(result.offsetDirection).toBeNull();
  });

  it('合格: 2音ともぴったり(cents=0)なら feedback=good・intervalAccuracy=1', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 }, // A(60)にぴったり
      { midi: null, count: 25 },
      { midi: 64, count: 30 }, // B(64)にぴったり
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.measured).toBe(true);
    expect(result.firstNoteCents).toBeCloseTo(0, 5);
    expect(result.secondNoteCents).toBeCloseTo(0, 5);
    expect(result.userIntervalCents).toBeCloseTo(400, 5);
    expect(result.intervalAccuracy).toBeCloseTo(1, 5);
    expect(result.directionOk).toBe(true);
    expect(result.feedback).toBe('good');
    expect(result.offsetDirection).toBeNull();
  });

  it('方向不一致(up出題でdownを歌う) → feedback=direction', () => {
    const processed = buildTimeline([
      { midi: 64, count: 30 }, // A(60)より高いところから入る(firstNoteCentsは判定に無関係)
      { midi: null, count: 25 },
      { midi: 60, count: 30 }, // 2つ目が下がる
    ]);
    const result = evaluateLevel3(processed, trialUp); // 出題はup
    expect(result.measured).toBe(true);
    expect(result.directionOk).toBe(false);
    expect(result.feedback).toBe('direction');
    expect(result.offsetDirection).toBeNull();
  });

  it('方向不一致(down出題でupを歌う) → feedback=direction(対称性の確認)', () => {
    const processed = buildTimeline([
      { midi: 64, count: 30 },
      { midi: null, count: 25 },
      { midi: 66, count: 30 }, // 上がってしまう
    ]);
    const result = evaluateLevel3(processed, trialDown); // 出題はdown
    expect(result.directionOk).toBe(false);
    expect(result.feedback).toBe('direction');
  });

  it('same方向判定の整合: ユーザーの幅がDIRECTION_SAME_CENTS以内(ほぼ動いていない)ならdirectionOk=falseでdirectionフィードバック', () => {
    // 60 -> 60.4(+40cent)。DIRECTION_SAME_CENTS=50以内なのでLevel 1と同じ分類で same 扱い
    // -> 出題(up)とは一致しないため方向不一致として扱われる。
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 60.4, count: 30 },
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.userIntervalCents).toBeCloseTo(40, 5);
    expect(Math.abs(result.userIntervalCents ?? 0)).toBeLessThanOrEqual(DIRECTION_SAME_CENTS);
    expect(result.directionOk).toBe(false);
    expect(result.feedback).toBe('direction');
  });

  it('幅のズレ: 方向は合っているが|error|がL3_INTERVAL_OK_CENTSを超える(2つ目が足りない→高く)', () => {
    // 目標幅400、ユーザー幅300(error=-100) -> offsetDirection='high'(2つ目をもっと高く)
    const processed = buildTimeline([
      { midi: 60, count: 30 }, // A(60)ぴったり
      { midi: null, count: 25 },
      { midi: 63, count: 30 }, // B(64)より低い
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.userIntervalCents).toBeCloseTo(300, 5);
    expect(result.directionOk).toBe(true);
    expect(result.feedback).toBe('interval');
    expect(result.offsetDirection).toBe('high');
  });

  it('幅のズレ: ユーザー幅が目標より広い(error=+150) -> offsetDirection=low(2つ目を低く)', () => {
    // A(60)ぴったり、B目標64だがユーザーは65.5(+150cent) -> ユーザー幅550、目標400、error=+150
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 65.5, count: 30 },
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.userIntervalCents).toBeCloseTo(550, 5);
    expect(result.directionOk).toBe(true);
    expect(result.feedback).toBe('interval');
    expect(result.offsetDirection).toBe('low');
  });

  it('境界: |error|=L3_INTERVAL_OK_CENTS(75)ちょうどはinterval扱いにしない(good側)', () => {
    // A(60)ぴったり=0cent、B=64.75(secondNoteCents=75) -> userInterval=475、目標400、error=75ちょうど
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 64.75, count: 30 },
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.userIntervalCents).toBeCloseTo(475, 5);
    expect(Math.abs(result.userIntervalCents! - 400)).toBeCloseTo(L3_INTERVAL_OK_CENTS, 5);
    expect(result.feedback).toBe('good'); // firstNoteCents=0のためoffset条件も満たさない
  });

  it('境界: |error|がL3_INTERVAL_OK_CENTSを1cent超えるとinterval扱いになる', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 64.76, count: 30 }, // error=76
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.feedback).toBe('interval');
  });

  it('全体ずれ: 幅はOKだが両音が同方向(共に高め)に50cent超ずれる -> feedback=offset・全体を低めに', () => {
    // A(60)より+100cent、B(64)より+100cent。ユーザー幅=400(目標どおり、error=0)
    const processed = buildTimeline([
      { midi: 61, count: 30 }, // 60+100cent
      { midi: null, count: 25 },
      { midi: 65, count: 30 }, // 64+100cent
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.firstNoteCents).toBeCloseTo(100, 5);
    expect(result.secondNoteCents).toBeCloseTo(100, 5);
    expect(result.userIntervalCents).toBeCloseTo(400, 5);
    expect(result.directionOk).toBe(true);
    expect(result.feedback).toBe('offset');
    expect(result.offsetDirection).toBe('low'); // 高すぎるので低めに
  });

  it('全体ずれ: 両音が同方向(共に低め)に50cent超ずれる -> offsetDirection=high(全体を高めに)', () => {
    const processed = buildTimeline([
      { midi: 59, count: 30 }, // 60-100cent
      { midi: null, count: 25 },
      { midi: 63, count: 30 }, // 64-100cent
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.feedback).toBe('offset');
    expect(result.offsetDirection).toBe('high');
  });

  it('境界: 両音とも±DIRECTION_SAME_CENTS(50)ちょうどのずれはoffset扱いにしない(good側)', () => {
    const processed = buildTimeline([
      { midi: 60.5, count: 30 }, // +50cent
      { midi: null, count: 25 },
      { midi: 64.5, count: 30 }, // +50cent
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.firstNoteCents).toBeCloseTo(50, 5);
    expect(result.secondNoteCents).toBeCloseTo(50, 5);
    expect(result.feedback).toBe('good');
  });

  it('両音が逆方向にずれた場合はoffset扱いにしない(good側。片方だけ・逆符号は「全体ずれ」ではない)', () => {
    const processed = buildTimeline([
      { midi: 60.6, count: 30 }, // +60cent
      { midi: null, count: 25 },
      { midi: 63.4, count: 30 }, // B(64)より-60cent(逆方向)
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(Math.sign(result.firstNoteCents!)).not.toBe(Math.sign(result.secondNoteCents!));
    // userInterval=(63.4-60.6)*100=280, error=280-400=-120 -> interval扱いが優先される
    expect(result.feedback).toBe('interval');
  });

  it('intervalAccuracyはINTERVAL_NORM_CENTSを超える大きな誤差で0にclampされる', () => {
    // 目標400、ユーザー700(error=300 > INTERVAL_NORM_CENTS=200) -> 1 - 300/200 = -0.5 -> clamp 0
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 67, count: 30 }, // +700cent
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.userIntervalCents).toBeCloseTo(700, 5);
    expect(result.intervalAccuracy).toBeCloseTo(0, 5);
    expect(result.feedback).toBe('interval'); // 大幅なズレでも方向は合っている
  });

  it('intervalAccuracyの式を既知値で検証(error=100 -> 1-100/INTERVAL_NORM_CENTS)', () => {
    const processed = buildTimeline([
      { midi: 60, count: 30 },
      { midi: null, count: 25 },
      { midi: 63, count: 30 }, // userInterval=300, error=-100
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.intervalAccuracy).toBeCloseTo(1 - 100 / INTERVAL_NORM_CENTS, 5);
  });

  it('フォールバック経路: 「んーんー」とつなげて歌った(無音ギャップなし)場合でも2音の高さを判定できる', () => {
    const processed = buildTimeline([
      { midi: 60, count: 60 }, // 前半(720ms) A(60)ぴったり
      { midi: 64, count: 60 }, // 後半(720ms) B(64)ぴったり — 区切りなしで連続
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.measured).toBe(true);
    expect(result.firstNoteCents).toBeCloseTo(0, 5);
    expect(result.secondNoteCents).toBeCloseTo(0, 5);
    expect(result.feedback).toBe('good');
  });

  it('フォールバック経路でも測定不能条件(有声合計不足)は維持される', () => {
    const processed = buildTimeline([{ midi: 60, count: 30 }]); // 360ms(<L1_FALLBACK_MIN_VOICED_MS=600ms)
    const result = evaluateLevel3(processed, trialUp);
    expect(result.measured).toBe(false);
  });

  it('セグメント境界: L1_SEGMENT_MIN_VOICED_MSちょうどのセグメントは有効に数える(inclusive)', () => {
    const exactCount = L1_SEGMENT_MIN_VOICED_MS / 12;
    const processed = buildTimeline([
      { midi: 60, count: exactCount },
      { midi: null, count: 25 },
      { midi: 64, count: exactCount },
    ]);
    const result = evaluateLevel3(processed, trialUp);
    expect(result.measured).toBe(true);
    expect(result.feedback).toBe('good');
  });
});
