// makeLevel2Spec のテスト。TRAINING_MODEL.md「目標音の範囲」「音域チェック済みの場合は測定値を優先」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLevel2Spec } from './level2';
import { GUARD_AFTER_PLAYBACK_MS, PHONATION_MAX_S, REFERENCE_TONE_MS } from '../constants';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('makeLevel2Spec — 既存の低め/高めプリセット(回帰)', () => {
  it('明示的なmidiNoteを渡すとそのまま採用する', () => {
    const spec = makeLevel2Spec('low', 52);
    expect(spec.targets).toEqual([{ midiNote: 52, startMs: 0, durationMs: REFERENCE_TONE_MS }]);
    expect(spec.levelId).toBe('level2');
    expect(spec.phonationMaxMs).toBe(PHONATION_MAX_S * 1000);
    expect(spec.guardAfterPlaybackMs).toBe(GUARD_AFTER_PLAYBACK_MS);
  });

  it('comfortRangeが無ければプリセットプール(low: C3-A3)から選ぶ', () => {
    const spec = makeLevel2Spec('low');
    expect([48, 50, 52, 53, 55, 57]).toContain(spec.targets[0].midiNote);
  });

  it('comfortRangeがnullでもプリセットプール(high: A3-E4)から選ぶ', () => {
    const spec = makeLevel2Spec('high', undefined, null);
    expect([57, 59, 60, 62, 64]).toContain(spec.targets[0].midiNote);
  });
});

describe('makeLevel2Spec — comfortRange指定時', () => {
  it('明示的なmidiNoteが優先され、comfortRangeより優先される', () => {
    const spec = makeLevel2Spec('low', 100, { lowMidi: 60, highMidi: 64 });
    expect(spec.targets[0].midiNote).toBe(100);
  });

  it('comfortRange内にスケール音が3音以上あれば、その範囲内からのみ選ぶ(C4-E4=ド/レ/ミの3音)', () => {
    const low = vi.spyOn(Math, 'random').mockReturnValue(0);
    const specLow = makeLevel2Spec('low', undefined, { lowMidi: 60, highMidi: 64 });
    expect(specLow.targets[0].midiNote).toBe(60); // ド4(プール先頭)
    low.mockRestore();

    const high = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const specHigh = makeLevel2Spec('low', undefined, { lowMidi: 60, highMidi: 64 });
    expect(specHigh.targets[0].midiNote).toBe(64); // ミ4(プール末尾)
    high.mockRestore();
  });

  it('3音未満なら±2半音ずつ広げて再試行し、届いた時点のプールを使う(C#4単独→B3-D4で3音)', () => {
    // 61(C#4)は半音階(黒鍵)のためスケール外。±2広げた59-63(B3-D4)で B3/C4/D4 の3音そろう。
    const low = vi.spyOn(Math, 'random').mockReturnValue(0);
    const specLow = makeLevel2Spec('low', undefined, { lowMidi: 61, highMidi: 61 });
    expect(specLow.targets[0].midiNote).toBe(59); // B3(広げた範囲のプール先頭)
    low.mockRestore();

    const high = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const specHigh = makeLevel2Spec('low', undefined, { lowMidi: 61, highMidi: 61 });
    expect(specHigh.targets[0].midiNote).toBe(62); // D4(広げた範囲のプール末尾)
    high.mockRestore();
  });

  it('2回広げても3音未満なら低め/高めのプリセットへフォールバックする(意図的に破損した逆転範囲)', () => {
    // lowMidi > highMidi(壊れたsettings値等の防御) — 広げても3試行(元/+2/+4)とも3音に届かない設計。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const spec = makeLevel2Spec('high', undefined, { lowMidi: 68, highMidi: 60 });
    expect([57, 59, 60, 62, 64]).toContain(spec.targets[0].midiNote); // highプリセットへフォールバック
  });

  it('exerciseIdはmidiNoteを含む一意な文字列になる', () => {
    const spec = makeLevel2Spec('low', 55);
    expect(spec.exerciseId).toContain('55');
    expect(spec.exerciseId).toMatch(/^level2-/);
  });
});
