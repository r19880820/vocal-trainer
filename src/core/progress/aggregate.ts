// Progress Tracking の週次集計(純TS。DOM禁止 — ARCHITECTURE.md 依存ルール「progress は scoring の型に依存」)。
// SkillSnapshot[] を skillId ごとに ISO週(月曜始まり)単位へ集計する。UI表示ロジックは持たない。
import { PARAMS_VERSION } from '../constants';
import type { SkillSnapshot } from '../types';

/** 直近何週まで返すか(新しい週が先頭)。 */
const MAX_WEEKS = 8;

export interface WeeklyPoint {
  /** ISO週ラベル(例: "2026-W33")。UIへの直接表示は想定しない(内部/テスト用)。 */
  weekLabel: string;
  /** その週の中央値 */
  median: number;
  /** その週に含まれる SkillSnapshot 件数 */
  count: number;
}

export type Trend = 'up' | 'flat' | 'down';

export interface WeekComparison {
  current: WeeklyPoint | null;
  previous: WeeklyPoint | null;
  /** 比較対象(前週)が無ければ null */
  trend: Trend | null;
}

/** ISO 8601 週番号ラベルを算出する(月曜始まり・その週の木曜日が属する年で採番)。 */
function isoWeekLabel(dateIso: string): string {
  const d = new Date(dateIso);
  const cursor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (cursor.getUTCDay() + 6) % 7; // 月=0 ... 日=6
  cursor.setUTCDate(cursor.getUTCDate() - dayNr + 3); // その週の木曜日へ移動(ISO週の所属年を決める基準)

  const firstThursday = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);

  const weekNumber = 1 + Math.round((cursor.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${cursor.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * skillId ごとの週次系列を返す(新しい週が先頭、直近 MAX_WEEKS 週まで)。
 * paramsVersion が現行(PARAMS_VERSION)と異なる snapshot は比較対象外として除外する
 * (較正で数値の意味が変わるため。ADR-004 / ARCHITECTURE.md 依存ルール — バージョン跨ぎ比較禁止)。
 */
export function weeklyBySkill(snapshots: SkillSnapshot[]): Record<string, WeeklyPoint[]> {
  const current = snapshots.filter((s) => s.paramsVersion === PARAMS_VERSION);

  const bySkill = new Map<string, Map<string, number[]>>();
  for (const s of current) {
    const week = isoWeekLabel(s.date);
    let weeks = bySkill.get(s.skillId);
    if (!weeks) {
      weeks = new Map();
      bySkill.set(s.skillId, weeks);
    }
    const values = weeks.get(week);
    if (values) values.push(s.value);
    else weeks.set(week, [s.value]);
  }

  const result: Record<string, WeeklyPoint[]> = {};
  for (const [skillId, weeks] of bySkill) {
    const points = [...weeks.entries()]
      .map(([weekLabel, values]) => ({ weekLabel, median: median(values), count: values.length }))
      .sort((a, b) => (a.weekLabel < b.weekLabel ? 1 : a.weekLabel > b.weekLabel ? -1 : 0)); // 新しい週が先頭
    result[skillId] = points.slice(0, MAX_WEEKS);
  }
  return result;
}

/**
 * 直近週と前週を比較する。points は新しい週が先頭(weeklyBySkill の出力をそのまま渡せる)。
 * higherIsBetter=false の指標(medianAbsCents 等、小さいほど良い)は方向を反転させる。
 */
export function compareLatestWeeks(points: WeeklyPoint[], higherIsBetter = true): WeekComparison {
  const [current, previous] = points;
  if (!current) return { current: null, previous: null, trend: null };
  if (!previous) return { current, previous: null, trend: null };
  const diff = current.median - previous.median;
  if (diff === 0) return { current, previous, trend: 'flat' };
  const improved = higherIsBetter ? diff > 0 : diff < 0;
  return { current, previous, trend: improved ? 'up' : 'down' };
}


// --- 音ごとのようす(UX_TRAINING.md §7 / 2026-08-16 ユーザー要望) ---
// skillId `noteAbsCents:<midi>` の snapshot を音ごとに集計する(progressStore.ts が記録元)。

export interface NoteStat {
  midi: number;
  /** その音のズレ中央値(cent、値が小さいほど良い) */
  medianAbsCents: number;
  count: number;
}

/**
 * 音ごとの成績一覧(midi昇順)。paramsVersion が現行と異なる snapshot は除外する。
 * 表示側の最小回数フィルタ(NOTE_MIN_COUNT)は UI の責務(ここでは全件返す)。
 */
export function noteBreakdown(snapshots: SkillSnapshot[]): NoteStat[] {
  const PREFIX = 'noteAbsCents:';
  const byMidi = new Map<number, number[]>();
  for (const s of snapshots) {
    if (s.paramsVersion !== PARAMS_VERSION) continue;
    if (!s.skillId.startsWith(PREFIX)) continue;
    const midi = Number(s.skillId.slice(PREFIX.length));
    if (!Number.isInteger(midi)) continue;
    const arr = byMidi.get(midi);
    if (arr) arr.push(s.value);
    else byMidi.set(midi, [s.value]);
  }
  return [...byMidi.entries()]
    .map(([midi, values]) => ({ midi, medianAbsCents: median(values), count: values.length }))
    .sort((a, b) => a.midi - b.midi);
}
