import { describe, expect, it } from 'vitest';
import { createProgressStore, type StorageLike } from './progressStore';
import type { ExerciseResult, ExerciseSpec } from '../core/types';

// テストはインメモリ StorageLike を注入する(ADR-004: 将来IndexedDBへの差し替えを見据えた抽象化)
function memoryStorage(initial?: Record<string, string>): StorageLike {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const SPEC: ExerciseSpec = {
  exerciseId: 'ex-level2-single-note',
  levelId: 'level2',
  targets: [{ midiNote: 60, startMs: 0, durationMs: 3000 }],
  phonationMaxMs: 5000,
  guardAfterPlaybackMs: 250,
};

function makeResult(overrides: Partial<ExerciseResult> = {}): ExerciseResult {
  return {
    spec: SPEC,
    timestamp: Date.UTC(2026, 6, 1, 3, 0, 0), // 2026-07-01T03:00:00Z
    paramsVersion: 1,
    validity: { isValid: true, reason: 'ok' },
    metrics: {
      pitchAccuracy: 0.8,
      medianAbsCents: 18,
      pitchStability: 0.6,
      attackAccuracy: 0.7,
    },
    octaveOff: 0,
    samples: [
      {
        sampleIndex: 0,
        timestampMs: 0,
        frequencyHzForScoring: 261.6,
        frequencyHzForDisplay: 261.6,
        midiNote: 60,
        voicing: 'voiced',
      },
    ],
    ...overrides,
  };
}

describe('progressStore', () => {
  it('append: validity=ok の結果を SkillSnapshot として保存する', () => {
    const store = createProgressStore(memoryStorage());
    store.append(makeResult());
    const all = store.loadAll();
    expect(all).toHaveLength(4); // pitchAccuracy, medianAbsCents, pitchStability, attackAccuracy
    const byId = Object.fromEntries(all.map((s) => [s.skillId, s]));
    expect(byId.pitchAccuracy.value).toBe(0.8);
    expect(byId.medianAbsCents.value).toBe(18);
    expect(byId.pitchStability.value).toBe(0.6);
    expect(byId.attackAccuracy.value).toBe(0.7);
    for (const s of all) {
      expect(s.date).toBe('2026-07-01T03:00:00.000Z');
      expect(s.exerciseId).toBe('ex-level2-single-note');
      expect(s.paramsVersion).toBe(1);
    }
  });

  it('append: pitchStability/attackAccuracy が null のときは該当 skillId を保存しない', () => {
    const store = createProgressStore(memoryStorage());
    store.append(
      makeResult({
        metrics: { pitchAccuracy: 0.2, medianAbsCents: 90, pitchStability: null, attackAccuracy: null },
      })
    );
    const ids = store.loadAll().map((s) => s.skillId);
    expect(ids).toEqual(['pitchAccuracy', 'medianAbsCents']);
  });

  it('append: validity.isValid=false の結果は保存しない(無効測定で履歴を汚さない)', () => {
    const store = createProgressStore(memoryStorage());
    store.append(makeResult({ validity: { isValid: false, reason: 'tooShort' } }));
    expect(store.loadAll()).toEqual([]);
    expect(store.practiceCount()).toBe(0);
  });

  it('append: samples は絶対に保存しない', () => {
    const storage = memoryStorage();
    const store = createProgressStore(storage);
    store.append(makeResult());
    const raw = storage.getItem('vt.progress.v1');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('samples');
    expect(raw).not.toContain('frequencyHzForScoring');
  });

  it('practiceCount: 有効な append 回数のみ数える', () => {
    const store = createProgressStore(memoryStorage());
    store.append(makeResult());
    store.append(makeResult({ validity: { isValid: false, reason: 'tooQuiet' } }));
    store.append(makeResult());
    expect(store.practiceCount()).toBe(2);
  });

  it('複数 append は追記される(既存履歴を上書きしない)', () => {
    const store = createProgressStore(memoryStorage());
    store.append(makeResult({ timestamp: Date.UTC(2026, 6, 1) }));
    store.append(makeResult({ timestamp: Date.UTC(2026, 6, 8) }));
    expect(store.practiceCount()).toBe(2);
    expect(store.loadAll()).toHaveLength(8);
  });

  it('clear: 履歴を全消去する', () => {
    const store = createProgressStore(memoryStorage());
    store.append(makeResult());
    store.clear();
    expect(store.loadAll()).toEqual([]);
    expect(store.practiceCount()).toBe(0);
  });

  it('loadAll: 壊れたJSONは空配列として扱う(握りつぶして継続)', () => {
    const store = createProgressStore(memoryStorage({ 'vt.progress.v1': '{not valid json' }));
    expect(store.loadAll()).toEqual([]);
    expect(store.practiceCount()).toBe(0);
  });

  it('loadAll: 配列でないJSON(想定外形式)は空配列として扱う', () => {
    const store = createProgressStore(memoryStorage({ 'vt.progress.v1': '{"foo":"bar"}' }));
    expect(store.loadAll()).toEqual([]);
  });

  it('append: setItem が例外を投げても(プライベートブラウズ等)握りつぶして継続する', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
    };
    const store = createProgressStore(storage);
    expect(() => store.append(makeResult())).not.toThrow();
  });

  it('loadAll: getItem が例外を投げても握りつぶして空配列を返す', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createProgressStore(storage);
    expect(store.loadAll()).toEqual([]);
  });

  it('clear: removeItem が例外を投げても握りつぶして継続する', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('boom');
      },
    };
    const store = createProgressStore(storage);
    expect(() => store.clear()).not.toThrow();
  });
});
