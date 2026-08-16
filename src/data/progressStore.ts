// Progress Tracking のストレージ実装。決定の正本は docs/decisions/ADR-004-progress-storage.md。
// data/ は core/ を参照可、逆は禁止(ARCHITECTURE.md 依存ルール) — ここでは core/types の SkillSnapshot と
// core/constants の PARAMS_VERSION のみ使う。
import type { ExerciseResult, SkillSnapshot } from '../core/types';
import { PARAMS_VERSION } from '../core/constants';

const KEY = 'vt.progress.v1';

/** localStorage 互換の最小 interface。テストはインメモリ実装を注入する(ADR-004)。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProgressStore {
  /** validity.isValid の結果のみ保存する。samples は絶対に含めない(ADR-004)。 */
  append(result: ExerciseResult): void;
  /**
   * ExerciseResult を経由しない単一の SkillSnapshot を直接追記する
   * (Level 1「音の上下」等、Level 2の ExerciseResult 型を持たないドリルの結果保存用)。
   * date=呼び出し時刻のISO 8601、paramsVersion=PARAMS_VERSION を自動付与する。
   */
  appendSnapshot(skillId: string, value: number, exerciseId: string): void;
  loadAll(): SkillSnapshot[];
  /** 保存済み(=validity ok)の練習回数 */
  practiceCount(): number;
  clear(): void;
}

function readAll(storage: StorageLike): SkillSnapshot[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return []; // 壊れたJSON/想定外形式は空扱い
    return parsed as SkillSnapshot[];
  } catch {
    return []; // 破損データは空扱いで継続
  }
}

function writeAll(storage: StorageLike, snapshots: SkillSnapshot[]): void {
  try {
    storage.setItem(KEY, JSON.stringify(snapshots));
  } catch {
    // プライベートブラウズ等での書き込み失敗は握りつぶして続行(練習体験を止めない — ADR-004)
  }
}

/** validity=ok の ExerciseResult.metrics を SkillSnapshot 配列へ変換する。null 指標は含めない。 */
function toSnapshots(result: ExerciseResult): SkillSnapshot[] {
  const base = {
    date: new Date(result.timestamp).toISOString(),
    exerciseId: result.spec.exerciseId,
    paramsVersion: result.paramsVersion,
  };
  const m = result.metrics;
  const snapshots: SkillSnapshot[] = [
    { skillId: 'pitchAccuracy', value: m.pitchAccuracy, ...base },
    { skillId: 'medianAbsCents', value: m.medianAbsCents, ...base },
  ];
  if (m.pitchStability !== null) snapshots.push({ skillId: 'pitchStability', value: m.pitchStability, ...base });
  if (m.attackAccuracy !== null) snapshots.push({ skillId: 'attackAccuracy', value: m.attackAccuracy, ...base });
  return snapshots;
}

/** 既存履歴の末尾へ snapshots を追記する共通処理(append / appendSnapshot で共有)。 */
function appendMany(storage: StorageLike, snapshots: SkillSnapshot[]): void {
  if (snapshots.length === 0) return;
  const existing = readAll(storage);
  writeAll(storage, [...existing, ...snapshots]);
}

export function createProgressStore(storage: StorageLike = localStorage): ProgressStore {
  return {
    append(result: ExerciseResult): void {
      if (!result.validity.isValid) return; // 無効測定で履歴を汚さない(ADR-004)
      appendMany(storage, toSnapshots(result));
    },
    appendSnapshot(skillId: string, value: number, exerciseId: string): void {
      appendMany(storage, [{ skillId, value, date: new Date().toISOString(), exerciseId, paramsVersion: PARAMS_VERSION }]);
    },
    loadAll(): SkillSnapshot[] {
      return readAll(storage);
    },
    practiceCount(): number {
      // pitchAccuracy は append 1回につき必ず1件書かれる(常時算出指標)ため、これを回数の基準にする
      return readAll(storage).filter((s) => s.skillId === 'pitchAccuracy').length;
    },
    clear(): void {
      try {
        storage.removeItem(KEY);
      } catch {
        // 失敗しても続行
      }
    },
  };
}
