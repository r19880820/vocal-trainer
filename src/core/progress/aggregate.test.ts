import { describe, expect, it } from 'vitest';
import { compareLatestWeeks, weeklyBySkill } from './aggregate';
import { PARAMS_VERSION } from '../constants';
import type { SkillSnapshot } from '../types';

function snap(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    skillId: 'pitchAccuracy',
    value: 0.5,
    date: '2026-08-10T03:00:00.000Z',
    exerciseId: 'ex-level2-single-note',
    paramsVersion: PARAMS_VERSION,
    ...overrides,
  };
}

describe('weeklyBySkill', () => {
  it('空データは空オブジェクトを返す', () => {
    expect(weeklyBySkill([])).toEqual({});
  });

  it('同一週内の複数snapshotは1つの週にまとめ、中央値を算出する(奇数件)', () => {
    // 2026-02-02(月)〜02-08(日)は同一ISO週
    expect(new Date('2026-02-02T00:00:00Z').getUTCDay()).toBe(1); // 事前確認: 月曜
    const snaps = [
      snap({ value: 0.2, date: '2026-02-02T00:00:00.000Z' }),
      snap({ value: 0.5, date: '2026-02-05T00:00:00.000Z' }),
      snap({ value: 0.9, date: '2026-02-08T23:59:59.000Z' }),
    ];
    const result = weeklyBySkill(snaps);
    expect(result.pitchAccuracy).toHaveLength(1);
    expect(result.pitchAccuracy[0].count).toBe(3);
    expect(result.pitchAccuracy[0].median).toBe(0.5);
  });

  it('偶数件の中央値は中間2件の平均', () => {
    const snaps = [
      snap({ value: 0.2, date: '2026-02-02T00:00:00.000Z' }),
      snap({ value: 0.4, date: '2026-02-03T00:00:00.000Z' }),
      snap({ value: 0.6, date: '2026-02-04T00:00:00.000Z' }),
      snap({ value: 0.8, date: '2026-02-05T00:00:00.000Z' }),
    ];
    expect(weeklyBySkill(snaps).pitchAccuracy[0].median).toBeCloseTo(0.5);
  });

  it('週境界: 月曜(新週)と直前の日曜(旧週)は別の週になる', () => {
    // 2026-02-09は月曜(02-02週の翌週)、2026-02-08は直前の日曜
    const snaps = [
      snap({ value: 0.3, date: '2026-02-08T23:59:59.000Z' }), // 旧週・日曜
      snap({ value: 0.7, date: '2026-02-09T00:00:00.000Z' }), // 新週・月曜
    ];
    const points = weeklyBySkill(snaps).pitchAccuracy;
    expect(points).toHaveLength(2);
    expect(points[0].weekLabel).not.toBe(points[1].weekLabel);
    expect(points[0].median).toBe(0.7); // 新しい週が先頭
    expect(points[1].median).toBe(0.3);
  });

  it('年またぎ: 2025-12-29(月)は2026-01-01(木)と同じISO週(2026-W01)になる', () => {
    const snaps = [
      snap({ value: 0.1, date: '2025-12-29T00:00:00.000Z' }),
      snap({ value: 0.9, date: '2026-01-01T00:00:00.000Z' }),
    ];
    const points = weeklyBySkill(snaps).pitchAccuracy;
    expect(points).toHaveLength(1);
    expect(points[0].weekLabel).toBe('2026-W01');
    expect(points[0].count).toBe(2);
  });

  it('年またぎ: 2025-12-28(日)は2025-12-29週より前の別の週になる', () => {
    const snaps = [
      snap({ value: 0.1, date: '2025-12-28T00:00:00.000Z' }),
      snap({ value: 0.9, date: '2025-12-29T00:00:00.000Z' }),
    ];
    const points = weeklyBySkill(snaps).pitchAccuracy;
    expect(points).toHaveLength(2);
    expect(points.find((p) => p.median === 0.9)?.weekLabel).toBe('2026-W01');
    expect(points.find((p) => p.median === 0.1)?.weekLabel).not.toBe('2026-W01');
  });

  it('paramsVersion が現行と異なる snapshot は集計から除外する(バージョン跨ぎ比較禁止)', () => {
    const snaps = [
      snap({ value: 0.9, paramsVersion: PARAMS_VERSION }),
      snap({ value: 0.1, paramsVersion: PARAMS_VERSION - 1 }),
    ];
    const points = weeklyBySkill(snaps).pitchAccuracy;
    expect(points).toHaveLength(1);
    expect(points[0].median).toBe(0.9);
    expect(points[0].count).toBe(1);
  });

  it('全snapshotが旧バージョンなら結果は空になる', () => {
    const snaps = [snap({ paramsVersion: PARAMS_VERSION - 1 })];
    expect(weeklyBySkill(snaps)).toEqual({});
  });

  it('skillId ごとに独立して集計する', () => {
    const snaps = [
      snap({ skillId: 'pitchAccuracy', value: 0.5 }),
      snap({ skillId: 'medianAbsCents', value: 40 }),
    ];
    const result = weeklyBySkill(snaps);
    expect(Object.keys(result).sort()).toEqual(['medianAbsCents', 'pitchAccuracy']);
    expect(result.medianAbsCents[0].median).toBe(40);
  });

  it('直近8週までに切り詰め、新しい週が先頭', () => {
    // 10週分、週ごとに1件ずつ(月曜日を7日おきに10個生成)
    const snaps: SkillSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.UTC(2026, 0, 5 + i * 7)); // 2026-01-05は月曜
      snaps.push(snap({ value: i, date: d.toISOString() }));
    }
    const points = weeklyBySkill(snaps).pitchAccuracy;
    expect(points).toHaveLength(8);
    expect(points[0].median).toBe(9); // 最新週が先頭
    expect(points[7].median).toBe(2); // 直近8週なので古い2週(value 0,1)は切り捨て
  });
});

describe('compareLatestWeeks', () => {
  it('データなし: current/previous ともに null, trend null', () => {
    expect(compareLatestWeeks([])).toEqual({ current: null, previous: null, trend: null });
  });

  it('1週分のみ: previous null, trend null', () => {
    const points = weeklyBySkill([snap({ value: 0.5 })]).pitchAccuracy;
    const cmp = compareLatestWeeks(points);
    expect(cmp.current?.median).toBe(0.5);
    expect(cmp.previous).toBeNull();
    expect(cmp.trend).toBeNull();
  });

  it('higherIsBetter=true(既定): 今週の値が高ければ up', () => {
    const points = [
      { weekLabel: '2026-W02', median: 0.8, count: 1 },
      { weekLabel: '2026-W01', median: 0.5, count: 1 },
    ];
    expect(compareLatestWeeks(points).trend).toBe('up');
  });

  it('higherIsBetter=true: 今週の値が低ければ down', () => {
    const points = [
      { weekLabel: '2026-W02', median: 0.3, count: 1 },
      { weekLabel: '2026-W01', median: 0.5, count: 1 },
    ];
    expect(compareLatestWeeks(points).trend).toBe('down');
  });

  it('同値は flat', () => {
    const points = [
      { weekLabel: '2026-W02', median: 0.5, count: 1 },
      { weekLabel: '2026-W01', median: 0.5, count: 1 },
    ];
    expect(compareLatestWeeks(points).trend).toBe('flat');
  });

  it('higherIsBetter=false(medianAbsCents等): 今週の値が小さければ up(改善)', () => {
    const points = [
      { weekLabel: '2026-W02', median: 15, count: 1 },
      { weekLabel: '2026-W01', median: 30, count: 1 },
    ];
    expect(compareLatestWeeks(points, false).trend).toBe('up');
  });

  it('higherIsBetter=false: 今週の値が大きければ down(悪化方向)', () => {
    const points = [
      { weekLabel: '2026-W02', median: 40, count: 1 },
      { weekLabel: '2026-W01', median: 20, count: 1 },
    ];
    expect(compareLatestWeeks(points, false).trend).toBe('down');
  });
});
