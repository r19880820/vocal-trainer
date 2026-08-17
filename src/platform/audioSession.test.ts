// melodySchedule(純関数)のテスト。playMelody本体はAudioContext(DOM)依存のためユニットテスト対象外
// (wav.test.tsと同じ方針: DOM非依存の純粋計算部分のみをテストする)。
import { describe, expect, it } from 'vitest';
import { melodySchedule, type MelodyNote } from './audioSession';

describe('melodySchedule', () => {
  it('各音の開始オフセットを先頭0からの累積(durationMs+gapAfterMs)で計算する', () => {
    const notes: MelodyNote[] = [
      { hz: 261.63, durationMs: 500, gapAfterMs: 100 },
      { hz: 293.66, durationMs: 500, gapAfterMs: 200 },
      { hz: 329.63, durationMs: 700, gapAfterMs: 0 },
    ];
    expect(melodySchedule(notes)).toEqual([0, 600, 1300]);
  });

  it('最終音のgapAfterMsはオフセット計算に影響しない(次の音が無いため参照されない)', () => {
    const notes: MelodyNote[] = [
      { hz: 440, durationMs: 300, gapAfterMs: 50 },
      { hz: 440, durationMs: 300, gapAfterMs: 99999 }, // 最終音: 大きな値でも後続が無いので無害
    ];
    expect(melodySchedule(notes)).toEqual([0, 350]);
  });

  it('1音のみなら先頭オフセット0のみ', () => {
    expect(melodySchedule([{ hz: 440, durationMs: 300, gapAfterMs: 50 }])).toEqual([0]);
  });

  it('空配列は空配列を返す', () => {
    expect(melodySchedule([])).toEqual([]);
  });
});
