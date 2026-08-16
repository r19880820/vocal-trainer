// Progress Tracking のストレージ実装。決定の正本は docs/decisions/ADR-004-progress-storage.md。
// data/ は core/ を参照可、逆は禁止(ARCHITECTURE.md 依存ルール) — ここでは core/types の SkillSnapshot のみ使う。
import type { ExerciseResult, SkillSnapshot } from '../core/types';

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

export function createProgressStore(storage: StorageLike = localStorage): ProgressStore {
  return {
    append(result: ExerciseResult): void {
      if (!result.validity.isValid) return; // 無効測定で履歴を汚さない(ADR-004)
      const existing = readAll(storage);
      writeAll(storage, [...existing, ...toSnapshots(result)]);
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
