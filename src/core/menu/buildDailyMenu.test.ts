// buildDailyMenu のテスト。TRAINING_MODEL.md「今日のメニュー(セッション化)」の編成ルール4ステップを検証する。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDailyMenu } from './buildDailyMenu';
import { PARAMS_VERSION, MENU_WARMUP_PHONATION_MS, MENU_WARMUP_TONE_MS, GUARD_AFTER_PLAYBACK_MS } from '../constants';
import type { SkillSnapshot } from '../types';

afterEach(() => {
  vi.restoreAllMocks();
});

// range='low' のプリセットプール(level1.ts/level2.ts の RANGE_SCALE_MIDI.low と同値)。comfortRange=null で使う。
// resolveCenterMidi(null, 'low') = snapToCMajor((48+57)/2=52.5) = 53(F3)
const LOW_CENTER_MIDI = 53;

function snap(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    skillId: 'noteAbsCents:50',
    value: 50,
    date: '2026-08-10T03:00:00.000Z',
    exerciseId: 'ex-1',
    paramsVersion: PARAMS_VERSION,
    ...overrides,
  };
}

describe('buildDailyMenu', () => {
  it('常に4ステップを返す(warmup→重点×2→finisher)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots: [] });
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.kind)).toEqual(['warmupLongTone', 'level2Focus', 'level1Set', 'finisher']);
  });

  it('全snapshotが旧paramsVersionで除外され実質データ無しの場合も a=Level2ランダム, b=Level1になる(レビュー指摘の回帰テスト)', () => {
    // snapshots自体は非空だが、noteBreakdown/weeklyBySkillの現行paramsVersionフィルタで全除外される
    // (較正更新直後のシナリオ)。snapshots.length===0だけで判定すると見落とすケース。
    const staleSnapshots = [
      snap({ skillId: 'noteAbsCents:57', value: 5, paramsVersion: PARAMS_VERSION - 1 }),
      snap({ skillId: 'directionAccuracy', value: 0.1, paramsVersion: PARAMS_VERSION - 1 }),
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots: staleSnapshots });
    expect(steps[1].kind).toBe('level2Focus');
    expect(steps[1].spec?.targets[0].midiNote).toBe(48);
    expect(steps[2].kind).toBe('level1Set');
  });

  it('データ無し構成: 重点は a=Level2ランダム, b=Level1(仕様の明示的な早期分岐)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // pool[0]=48
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots: [] });
    expect(steps[1].kind).toBe('level2Focus');
    expect(steps[1].spec?.targets[0].midiNote).toBe(48);
    expect(steps[2].kind).toBe('level1Set');
    expect(steps[2].spec).toBeUndefined();
    // finisher: 最良音データが無いので中央音にフォールバック
    expect(steps[3].kind).toBe('finisher');
    expect(steps[3].spec?.targets[0].midiNote).toBe(LOW_CENTER_MIDI);
  });

  it('最悪音選出: count>=NOTE_MIN_COUNTの音のうちmedianAbsCents最大の音がLevel2集中になる(count不足の音は無視)', () => {
    const snapshots = [
      snap({ skillId: 'noteAbsCents:50', value: 20, exerciseId: 'e1', date: '2026-08-03T00:00:00.000Z' }),
      snap({ skillId: 'noteAbsCents:50', value: 40, exerciseId: 'e2', date: '2026-08-04T00:00:00.000Z' }), // 50の中央値=30
      snap({ skillId: 'noteAbsCents:53', value: 80, exerciseId: 'e3', date: '2026-08-03T00:00:00.000Z' }),
      snap({ skillId: 'noteAbsCents:53', value: 100, exerciseId: 'e4', date: '2026-08-04T00:00:00.000Z' }), // 53の中央値=90(最悪)
      snap({ skillId: 'noteAbsCents:57', value: 999, exerciseId: 'e5', date: '2026-08-03T00:00:00.000Z' }), // count=1のため無視されるべき
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[1].kind).toBe('level2Focus');
    expect(steps[1].spec?.targets[0].midiNote).toBe(53);
    expect(steps[1].title).toContain('集中練習');
  });

  it('弱スキル選出: directionAccuracy直近週中央値<0.6でLevel1が重点に入る(音データ無しでaは不発)', () => {
    const snapshots = [
      snap({ skillId: 'directionAccuracy', value: 0.2, exerciseId: 'l1-1', date: '2026-08-10T00:00:00.000Z' }),
      snap({ skillId: 'directionAccuracy', value: 0.3, exerciseId: 'l1-2', date: '2026-08-11T00:00:00.000Z' }),
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[1].kind).toBe('level1Set');
    // 残り1枠はd(Level2ランダム)で埋まる
    expect(steps[2].kind).toBe('level2Focus');
  });

  it('弱スキル選出: intervalAccuracy直近週中央値<0.6でLevel3が重点に入る(direction/note データ無し)', () => {
    const snapshots = [
      snap({ skillId: 'intervalAccuracy', value: 0.1, exerciseId: 'l3-1', date: '2026-08-10T00:00:00.000Z' }),
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[1].kind).toBe('level3Trial');
    expect(steps[2].kind).toBe('level2Focus');
  });

  it('directionAccuracyが閾値以上なら弱点としては入らない(bは不発。2枠目は多様性ルールでLevel 1)', () => {
    // 2026-08-17 多様性ルール: 1枠目が単音集中なら2枠目は別種目(Level 1)を優先 —
    // 「4つ全部が単音練習で構造が分からない」実走フィードバック対応
    const snapshots = [
      snap({ skillId: 'directionAccuracy', value: 0.9, exerciseId: 'l1-1', date: '2026-08-10T00:00:00.000Z' }),
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[1].kind).toBe('level2Focus');
    expect(steps[2].kind).toBe('level1Set');
  });

  it('多様性ルール(2026-08-17): 1枠目が最悪音の単音集中なら、2枠目は別種目(Level 1)になる', () => {
    const snapshots = [
      snap({ skillId: 'noteAbsCents:50', value: 80, exerciseId: 'e1', date: '2026-08-03T00:00:00.000Z' }),
      snap({ skillId: 'noteAbsCents:50', value: 100, exerciseId: 'e2', date: '2026-08-04T00:00:00.000Z' }), // 中央値90(唯一の候補=worst)
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[1].kind).toBe('level2Focus');
    expect(steps[1].spec?.targets[0].midiNote).toBe(50);
    expect(steps[2].kind).toBe('level1Set'); // 単音集中を2連続にしない
  });

  it('finisher最良音: count>=NOTE_MIN_COUNTの音のうちmedianAbsCents最小の音がfinisherになる', () => {
    const snapshots = [
      snap({ skillId: 'noteAbsCents:50', value: 80, exerciseId: 'e1', date: '2026-08-03T00:00:00.000Z' }),
      snap({ skillId: 'noteAbsCents:50', value: 100, exerciseId: 'e2', date: '2026-08-04T00:00:00.000Z' }), // 中央値90
      snap({ skillId: 'noteAbsCents:53', value: 10, exerciseId: 'e3', date: '2026-08-03T00:00:00.000Z' }),
      snap({ skillId: 'noteAbsCents:53', value: 20, exerciseId: 'e4', date: '2026-08-04T00:00:00.000Z' }), // 中央値15(最良)
      snap({ skillId: 'noteAbsCents:48', value: 0, exerciseId: 'e5', date: '2026-08-03T00:00:00.000Z' }), // count=1のため無視
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots });
    expect(steps[3].kind).toBe('finisher');
    expect(steps[3].spec?.targets[0].midiNote).toBe(53);
    // 53 = F3(midiToSolfege: 53%12=5 -> 'ファ')
    expect(steps[3].title).toBe('しあげ — ファ3');
  });

  it('finisherは音データが無ければ楽な範囲の中央音にフォールバックする', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: { lowMidi: 60, highMidi: 71 }, range: 'low', snapshots: [] });
    // snapToCMajor((60+71)/2=65.5) -> round=66(F#…ではなく最寄りのスケール音) 65=F(isCMajor: 65%12=5=F -> true)
    // round(65.5)=66, isCMajor(66)? 66%12=6 -> ファ#(黒鍵)ではない。d=0..: 66-0 false, 66+0 false,
    // d=1: 65 true -> 65。よって中央音は65(F4)
    expect(steps[3].spec?.targets[0].midiNote).toBe(65);
  });

  it('warmupのdurationMs差し替え: targets[0].durationMs/phonationMaxMsがMENU_WARMUP値に置き換わり他は保持される', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: null, range: 'low', snapshots: [] });
    const warmup = steps[0];
    expect(warmup.kind).toBe('warmupLongTone');
    expect(warmup.spec).toBeDefined();
    const spec = warmup.spec!;
    expect(spec.targets[0].durationMs).toBe(MENU_WARMUP_TONE_MS);
    expect(spec.phonationMaxMs).toBe(MENU_WARMUP_PHONATION_MS);
    // 差し替え対象以外は makeLevel2Spec のベースのまま保持される
    expect(spec.targets[0].midiNote).toBe(LOW_CENTER_MIDI);
    expect(spec.targets[0].startMs).toBe(0);
    expect(spec.guardAfterPlaybackMs).toBe(GUARD_AFTER_PLAYBACK_MS);
    expect(spec.levelId).toBe('level2');
  });

  it('comfortRange指定時は中央がその範囲内から選ばれる(プリセットに無い音でもよい)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const steps = buildDailyMenu({ comfortRange: { lowMidi: 60, highMidi: 64 }, range: 'low', snapshots: [] });
    // snapToCMajor((60+64)/2=62)=62(D4、Cメジャー音)
    expect(steps[0].spec?.targets[0].midiNote).toBe(62);
  });
});


// --- Codexクロスレビュー指摘(2026-08-17)の回帰テスト ---
describe('buildDailyMenu — Codexレビュー回帰', () => {
  const midiOf = (step: { spec?: { targets: Array<{ midiNote: number }> } }) => step.spec?.targets[0]?.midiNote;

  it('【指摘2】現在の音域外の過去履歴音は重点・しあげに出題しない', () => {
    // 現在の楽な範囲=55〜64。過去履歴の最悪音48/最良音50は範囲外 → どちらも出題されない
    const snapshots = [
      snap({ skillId: 'noteAbsCents:48', value: 90 }),
      snap({ skillId: 'noteAbsCents:48', value: 95 }),
      snap({ skillId: 'noteAbsCents:50', value: 5 }),
      snap({ skillId: 'noteAbsCents:50', value: 6 }),
    ];
    const menu = buildDailyMenu({ comfortRange: { lowMidi: 55, highMidi: 64 }, range: 'high', snapshots });
    for (const step of menu) {
      const midi = midiOf(step);
      if (midi !== undefined) {
        expect(midi).toBeGreaterThanOrEqual(55);
        expect(midi).toBeLessThanOrEqual(64);
      }
    }
  });

  it('【指摘3】統計対象が1音だけでも、重点(最悪音)としあげが同じ音にならない', () => {
    // 57のみ履歴あり(最悪かつ最良)。重点=57は許容、しあげは別の音になる
    const snapshots = [
      snap({ skillId: 'noteAbsCents:57', value: 80 }),
      snap({ skillId: 'noteAbsCents:57', value: 85 }),
    ];
    const menu = buildDailyMenu({ comfortRange: { lowMidi: 48, highMidi: 59 }, range: 'low', snapshots });
    const focusMidis = menu.filter((s) => s.kind === 'level2Focus').map(midiOf);
    const finisher = menu.find((s) => s.kind === 'finisher');
    expect(focusMidis).toContain(57);
    expect(midiOf(finisher!)).not.toBe(57);
  });

  it('【指摘3】データ無しでも、ランダム重点がウォームアップの中央音と重複しない', () => {
    for (let i = 0; i < 20; i++) {
      const menu = buildDailyMenu({ comfortRange: { lowMidi: 48, highMidi: 59 }, range: 'low', snapshots: [] });
      const warmupMidi = midiOf(menu[0]);
      const focusMidis = menu.filter((s) => s.kind === 'level2Focus').map(midiOf);
      expect(focusMidis).not.toContain(warmupMidi);
    }
  });
});
