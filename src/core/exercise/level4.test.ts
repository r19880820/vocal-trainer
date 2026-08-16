// extractNoteEvents / collapseRepeats / evaluateLevel4 のテスト。
// TRAINING_MODEL.md「Level 4: 短いメロディ」v2(評価アルゴリズム5段階)。
import { describe, expect, it } from 'vitest';
import { collapseRepeats, evaluateLevel4, extractNoteEvents } from './level4';
import type { ProcessedPitchSample, Voicing } from '../types';
import { midiToHz } from '../pitch/conversions';
import { L4_EVENT_BREAK_MS } from '../constants';

// --- テスト用ヘルパー(level1.test.ts の buildTimeline と同じ思想。ms指定版) ---
function buildTimeline(spec: Array<{ midi: number | null; ms: number }>, hopMs = 10): ProcessedPitchSample[] {
  const out: ProcessedPitchSample[] = [];
  let t = 0;
  for (const seg of spec) {
    const count = Math.round(seg.ms / hopMs);
    const voicing: Voicing = seg.midi !== null ? 'voiced' : 'silent';
    const hz = seg.midi !== null ? midiToHz(seg.midi) : 0;
    for (let i = 0; i < count; i++) {
      out.push({
        sampleIndex: Math.round(t / hopMs),
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

/** 複数音を1つの連続した発声(スライド遷移込み)として繋げる評価テスト用ヘルパー。 */
function buildSungMelody(midis: number[], holdMs = 400, slideMs = 40, hopMs = 10): ProcessedPitchSample[] {
  const spec: Array<{ midi: number; ms: number }> = [];
  midis.forEach((m, i) => {
    spec.push({ midi: m, ms: holdMs });
    if (i < midis.length - 1) {
      spec.push({ midi: (m + midis[i + 1]) / 2, ms: slideMs });
    }
  });
  return buildTimeline(spec, hopMs);
}

describe('extractNoteEvents', () => {
  it('安定音+スライド遷移: 遷移区間(150ms未満)は捨てられ、前後の安定音2つだけがイベントになる', () => {
    const processed = buildTimeline([
      { midi: 60, ms: 400 },
      { midi: 62, ms: 50 }, // 遷移(200cent離れているので別イベント化されるが150ms未満で捨てられる)
      { midi: 64, ms: 400 },
    ]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(2);
    expect(events[0].midi).toBeCloseTo(60, 5);
    expect(events[1].midi).toBeCloseTo(64, 5);
  });

  it('息継ぎ分断: 非voicedがL4_EVENT_BREAK_MS以上続くとランが分断され、同じ高さでも別イベントになる', () => {
    const processed = buildTimeline([
      { midi: 60, ms: 400 },
      { midi: null, ms: L4_EVENT_BREAK_MS + 20 },
      { midi: 60, ms: 400 },
    ]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(2);
    expect(events[0].midi).toBeCloseTo(60, 5);
    expect(events[1].midi).toBeCloseTo(60, 5);
  });

  it('非voicedがL4_EVENT_BREAK_MS未満なら分断せず1つのランとして扱う', () => {
    const processed = buildTimeline([
      { midi: 60, ms: 400 },
      { midi: null, ms: L4_EVENT_BREAK_MS - 20 },
      { midi: 60, ms: 400 },
    ]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(1);
  });

  it('150ms未満のイベントは除外される(短い自験からの一瞬の音は捨てる)', () => {
    const processed = buildTimeline([
      { midi: 60, ms: 400 },
      { midi: null, ms: L4_EVENT_BREAK_MS + 20 },
      { midi: 67, ms: 100 }, // トリム後50ms(<150ms)しか残らず除外される
    ]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(1);
    expect(events[0].midi).toBeCloseTo(60, 5);
  });

  it('各ランの先頭50msは捨てられる(イベントのstartMsが50ms後ろにずれる)', () => {
    const processed = buildTimeline([{ midi: 60, ms: 400 }]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(1);
    expect(events[0].startMs).toBeCloseTo(50, 5);
    expect(events[0].voicedMs).toBeCloseTo(350, 5);
  });

  it('同音を切れ目なく伸ばして歌った場合は1イベントにまとまる', () => {
    const processed = buildTimeline([{ midi: 64, ms: 500 }]);
    const events = extractNoteEvents(processed);
    expect(events).toHaveLength(1);
    expect(events[0].midi).toBeCloseTo(64, 5);
  });

  it('voicedサンプルが無ければ空配列', () => {
    const processed = buildTimeline([{ midi: null, ms: 300 }]);
    expect(extractNoteEvents(processed)).toEqual([]);
  });
});

describe('collapseRepeats', () => {
  it('ドドソソララソ→ドソラソ(隣接同一音を畳む)', () => {
    // ド=0, ソ=7, ラ=9
    expect(collapseRepeats([0, 0, 7, 7, 9, 9, 7])).toEqual([0, 7, 9, 7]);
  });

  it('全て異なる音なら畳まない', () => {
    expect(collapseRepeats([0, 2, 4, 5])).toEqual([0, 2, 4, 5]);
  });

  it('空配列はそのまま', () => {
    expect(collapseRepeats([])).toEqual([]);
  });
});

describe('evaluateLevel4', () => {
  const TARGET = [60, 62, 64, 60, 62, 64]; // ド・レ・ミ・ド・レ・ミ相当(6音、隣接重複なし)

  it('完璧に歌った(遷移スライド込み)→ 全match・melodyAccuracy=1.0', () => {
    const processed = buildSungMelody(TARGET);
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(true);
    expect(result.keyOffset).toBe(false);
    expect(result.offsetCents).toBeCloseTo(0, -1); // 数十centの丸め誤差は許容
    expect(result.alignment.every((e) => e.kind === 'match')).toBe(true);
    expect(result.melodyAccuracy).toBe(1);
  });

  it('+70centの一律バイアス → オフセット除去で全match(C-4回帰)', () => {
    const biased = TARGET.map((m) => m + 0.7); // +70cent
    const processed = buildSungMelody(biased);
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(true);
    expect(result.keyOffset).toBe(false); // 70 < L4_KEY_OFFSET_CENTS(150)
    expect(result.offsetCents).toBeCloseTo(70, -1);
    expect(result.alignment.every((e) => e.kind === 'match')).toBe(true);
    expect(result.melodyAccuracy).toBe(1);
  });

  it('4度下で正しく歌った → keyOffset=true かつ形はmatch(C-3回帰)', () => {
    const downFourth = TARGET.map((m) => m - 5); // 完全4度=5半音下
    const processed = buildSungMelody(downFourth);
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(true);
    expect(result.keyOffset).toBe(true); // 500cent > 150
    expect(result.alignment.every((e) => e.kind === 'match')).toBe(true);
    expect(result.melodyAccuracy).toBe(1);
  });

  it('1音だけ+150centずらす → その位置がsub、他はmatchのまま(C-2回帰)', () => {
    const sungMidis = [...TARGET];
    sungMidis[2] = TARGET[2] + 1.5; // 150cent(> L4_NOTE_OK_CENTS=75)ずらす
    const processed = buildSungMelody(sungMidis);
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(true);
    expect(result.keyOffset).toBe(false); // 1音だけのズレは中央値に埋もれる
    expect(result.alignment.map((e) => e.kind)).toEqual(['match', 'match', 'sub', 'match', 'match', 'match']);
    expect(result.melodyAccuracy).toBeCloseTo(5 / 6, 5);
    expect(result.firstIssueTargetIndex).toBe(2);
  });

  it('1音抜かす → del 1つ・他はmatch(位置比較なら崩壊するケース)', () => {
    const sungMidis = [TARGET[0], TARGET[1], TARGET[3], TARGET[4], TARGET[5]]; // index2(64)を丸ごと歌わない
    const processed = buildSungMelody(sungMidis);
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(true);
    const kinds = result.alignment.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'del')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'match')).toHaveLength(5);
    const delEntry = result.alignment.find((e) => e.kind === 'del');
    expect(delEntry?.targetIndex).toBe(2);
    expect(result.melodyAccuracy).toBeCloseTo(5 / 6, 5);
    expect(result.firstIssueTargetIndex).toBe(2);
  });

  it('「ドド」を1回で伸ばして歌っても、2回に区切って(息継ぎして)歌っても同じ結果になる(C-1回帰)', () => {
    const target = [60, 60, 64]; // 縮約後は[60,64]

    const sustained = buildTimeline([
      { midi: 60, ms: 830 }, // 1回で伸ばす(区切りなし)
      { midi: 62, ms: 40 }, // 遷移
      { midi: 64, ms: 400 },
    ]);
    const reattacked = buildTimeline([
      { midi: 60, ms: 400 },
      { midi: null, ms: L4_EVENT_BREAK_MS + 20 }, // 息継ぎ
      { midi: 60, ms: 400 }, // 同じ音を歌い直す
      { midi: 62, ms: 40 }, // 遷移
      { midi: 64, ms: 400 },
    ]);

    const sustainedResult = evaluateLevel4(sustained, target);
    const reattackedResult = evaluateLevel4(reattacked, target);

    expect(sustainedResult.measured).toBe(true);
    expect(reattackedResult.measured).toBe(true);
    expect(sustainedResult.alignment).toHaveLength(2);
    expect(reattackedResult.alignment).toHaveLength(2);
    expect(sustainedResult.alignment.every((e) => e.kind === 'match')).toBe(true);
    expect(reattackedResult.alignment.every((e) => e.kind === 'match')).toBe(true);
    expect(sustainedResult.melodyAccuracy).toBe(reattackedResult.melodyAccuracy);
    expect(sustainedResult.melodyAccuracy).toBe(1);
  });

  it('有声時間が不足していれば測定不能(measured=false)', () => {
    const processed = buildTimeline([{ midi: 60, ms: 300 }]); // <L4_VALID_MIN_VOICED_MS(800)
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(false);
    expect(result.offsetCents).toBeNull();
    expect(result.melodyAccuracy).toBeNull();
    expect(result.alignment).toEqual([]);
    expect(result.firstIssueTargetIndex).toBeNull();
  });

  it('有声時間は十分でもイベントが1つしか無ければ測定不能', () => {
    const processed = buildTimeline([{ midi: 60, ms: 1000 }]); // 950ms voiced(>=800)だが1音のみ
    const result = evaluateLevel4(processed, TARGET);
    expect(result.measured).toBe(false);
  });
});
