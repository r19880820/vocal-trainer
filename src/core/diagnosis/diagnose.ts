// Weakness Detection。正本は docs/TRAINING_MODEL.md「Scoring → Weakness Detection」節。
// diagnosis/ は scoring の出力(ExerciseResult)を弱点診断に変換する層
// (ARCHITECTURE.md 依存順序: scoring < diagnosis)。

import type { Diagnosis, ExerciseMetrics, ExerciseResult } from '../types';
import { REACH_TARGET_ACCURACY } from '../constants';

// TRAINING_MODEL.md「参照バンド(暫定・要較正)」表。低いバンドほど弱点。
// low/high は「初級/中級」「中級/上級」境界。値は全て 0..1 に正規化された指標。
type BandKey = 'pitchAccuracy' | 'pitchStability' | 'attackAccuracy';

interface BandDef {
  key: BandKey;
  low: number;
  high: number;
}

const BANDS: BandDef[] = [
  { key: 'pitchAccuracy', low: 0.4, high: 0.75 },
  { key: 'pitchStability', low: 0.3, high: 0.7 },
  { key: 'attackAccuracy', low: 0.5, high: 0.8 },
];

// 同バンド内タイの最終タイブレーク用の固定優先順(正規化位置も同点になる縮退ケース用)。
const METRIC_PRIORITY: BandKey[] = ['pitchAccuracy', 'pitchStability', 'attackAccuracy'];

/** レビューm-1: BANDS lookup を検証付きに。未知キーは undefined を返す(呼び出し側で安全に除外)。 */
function findBand(key: string): BandDef | undefined {
  return BANDS.find((b) => b.key === key);
}

/** key が BANDS に定義された既知の BandKey かどうか(レビューm-1: 未知キーの安全な除外用)。 */
function isBandKey(key: string): key is BandKey {
  return findBand(key) !== undefined;
}

/** 0=初級(最も弱い) / 1=中級 / 2=上級 */
function bandRank(value: number, low: number, high: number): 0 | 1 | 2 {
  if (value < low) return 0;
  if (value < high) return 1;
  return 2;
}

/**
 * レビューM-2: バンド内の正規化位置を算出する。
 * 正規化位置 = (value - low) / (high - low)。rank0は low=0(指標の取り得る下限)、
 * rank2は high=1(指標の取り得る上限)とみなした仮想バンド内での位置。
 * 生値のバンド下限からの距離(旧実装)は使わない — 異なるバンド幅を持つ指標間の比較を
 * 公平にするため(例: stability[0.3,0.7) と accuracy[0.4,0.75) は下限からの生距離では比較不能)。
 */
function normalizedBandPosition(value: number, rank: 0 | 1 | 2, low: number, high: number): number {
  if (rank === 0) {
    return low > 0 ? value / low : 0;
  }
  if (rank === 1) {
    return high > low ? (value - low) / (high - low) : 0;
  }
  // rank === 2
  return 1 - high > 0 ? (value - high) / (1 - high) : 1;
}

interface Candidate {
  key: BandKey;
  rank: 0 | 1 | 2;
  normPos: number;
}

/**
 * 通常判定(ステップ4): null でない指標のみを対象に、参照バンド内順位が最も低い指標を選ぶ。
 * 同バンド内は正規化バンド内位置(レビューM-2)が小さい方(相対的により深く弱い方)を選ぶ。
 * 生値argminには縮退しない。
 */
function pickWeakestMetric(metrics: ExerciseMetrics): BandKey | null {
  const candidates: Candidate[] = [];
  for (const band of BANDS) {
    const value = metrics[band.key] as number | null | undefined;
    if (value === null || value === undefined) continue;
    const rank = bandRank(value, band.low, band.high);
    const normPos = normalizedBandPosition(value, rank, band.low, band.high);
    candidates.push({ key: band.key, rank, normPos });
  }
  if (candidates.length === 0) return null;

  const minRank = Math.min(...candidates.map((c) => c.rank));
  const worst = candidates.filter((c) => c.rank === minRank);
  worst.sort((a, b) => {
    if (a.normPos !== b.normPos) return a.normPos - b.normPos;
    return METRIC_PRIORITY.indexOf(a.key) - METRIC_PRIORITY.indexOf(b.key);
  });
  return worst[0].key;
}

/**
 * レビューm-8(ステップ3b): null でない指標が全て上級バンド(rank===2)なら「弱点なし」。
 * 弱点をでっち上げない。非null候補が1つも無い場合(理論上到達しないが防御的に)は false。
 */
function isAllGood(metrics: ExerciseMetrics): boolean {
  let sawAny = false;
  for (const band of BANDS) {
    const value = metrics[band.key] as number | null | undefined;
    if (value === null || value === undefined) continue;
    sawAny = true;
    if (bandRank(value, band.low, band.high) !== 2) return false;
  }
  return sawAny;
}

/**
 * 直前の Diagnosis.rationale から、その回の「生の(ヒステリシス適用前の)候補弱点」を取り出す。
 * rationale は自由記述文字列(型上は「ルールID」)だが、本モジュール内では
 * `normal:<key>` / `normal:<key>:held` という自前フォーマットで、ヒステリシスの
 * 「2回連続で検出」判定に必要な生候補を history 経由で復元するために使う
 * (Diagnosis 型に生候補を保持する専用フィールドが無く、types.ts は変更禁止のための実装判断。
 * 最終報告で明記)。
 */
function extractRawCandidate(rationale: string | undefined): BandKey | null {
  if (!rationale) return null;
  const m = /^normal:(pitchAccuracy|pitchStability|attackAccuracy)/.exec(rationale);
  return m ? (m[1] as BandKey) : null;
}

function isBandMarginExceeded(
  metrics: ExerciseMetrics,
  candidateKey: BandKey,
  prevWeaknessKey: BandKey
): boolean {
  // レビューm-1: BANDS lookup を検証付きに。未知キーなら(理論上到達しないが)throwせず、
  // 安全側(marginは未達=false)にフォールバックする。
  const candidateBand = findBand(candidateKey);
  const prevBand = findBand(prevWeaknessKey);
  if (!candidateBand || !prevBand) return false;
  const candidateValue = metrics[candidateKey] as number | null | undefined;
  const prevValue = metrics[prevWeaknessKey] as number | null | undefined;
  if (candidateValue == null || prevValue == null) return false;
  const candidateRank = bandRank(candidateValue, candidateBand.low, candidateBand.high);
  const prevRank = bandRank(prevValue, prevBand.low, prevBand.high);
  return candidateRank <= prevRank - 1;
}

/**
 * レビューM-3: ヒステリシスの前回参照は「historyを新しい方から遡って最初の
 * primaryWeakness が非null の Diagnosis」まで遡る(直近1件に固定しない)。
 * validity無効・octaveOff・reachTarget・allGood はいずれも primaryWeakness=null を
 * 返すため、そのようなセッションを1回挟んだだけでヒステリシスが消えてしまうのを防ぐ。
 */
function findLastNonNullWeaknessDiagnosis(history: Diagnosis[]): Diagnosis | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].primaryWeakness !== null) return history[i];
  }
  return null;
}

function normalDiagnosis(result: ExerciseResult, history: Diagnosis[]): Diagnosis {
  const candidateKey = pickWeakestMetric(result.metrics);
  if (candidateKey === null) {
    // 理論上ステップ3(reachTarget)で捕捉されるはずだが、防御的にフォールバックする。
    return { primaryWeakness: null, octaveOff: 0, isReliable: true, rationale: 'reachTarget:fallback' };
  }

  const prev = findLastNonNullWeaknessDiagnosis(history);
  // レビューm-1: primaryWeakness は型上 keyof ExerciseMetrics 全体を許容するため、
  // BANDS に無い未知キー(medianAbsCents 等)は候補から安全に除外する(素通しでキャストしない)。
  const prevWeaknessRaw = prev?.primaryWeakness ?? null;
  const prevWeakness: BandKey | null =
    prevWeaknessRaw !== null && isBandKey(prevWeaknessRaw) ? prevWeaknessRaw : null;

  if (prevWeakness === null || prevWeakness === candidateKey) {
    return {
      primaryWeakness: candidateKey,
      octaveOff: 0,
      isReliable: true,
      rationale: `normal:${candidateKey}`,
    };
  }

  // 弱点が切り替わる場合: (a) 新弱点が2回連続で検出 または (b) バンドが1段以上明確に低い
  // のどちらかを満たさなければ前回の弱点を維持する(ヒステリシス)。
  const prevRawCandidate = extractRawCandidate(prev?.rationale);
  const twoInARow = prevRawCandidate === candidateKey;
  const marginExceeded = isBandMarginExceeded(result.metrics, candidateKey, prevWeakness);

  if (twoInARow || marginExceeded) {
    return {
      primaryWeakness: candidateKey,
      octaveOff: 0,
      isReliable: true,
      rationale: `normal:${candidateKey}`,
    };
  }

  return {
    primaryWeakness: prevWeakness,
    octaveOff: 0,
    isReliable: false,
    rationale: `normal:${candidateKey}:held`,
  };
}

/**
 * ExerciseResult + 過去の Diagnosis 履歴(古→新)から弱点を診断する。
 * TRAINING_MODEL.md「Scoring → Weakness Detection」の5ステップをそのまま実装する。
 */
export function diagnose(result: ExerciseResult, history: Diagnosis[]): Diagnosis {
  // 1. validity 無効 → 弱点判定せず理由別に終了
  if (!result.validity.isValid) {
    return {
      primaryWeakness: null,
      octaveOff: result.octaveOff,
      isReliable: true,
      rationale: `invalid:${result.validity.reason}`,
    };
  }

  // 2. octaveOff != 0 → 弱点判定より優先
  if (result.octaveOff !== 0) {
    return {
      primaryWeakness: null,
      octaveOff: result.octaveOff,
      isReliable: true,
      rationale: 'octaveOff',
    };
  }

  // 3. pitchAccuracy < REACH_TARGET_ACCURACY 単独条件 → 専用ブランチ(レビューC-3)。
  // attack/stability の null 有無には依存しない — 一瞬±50centをかすっただけで
  // attackAccuracy/pitchStability が非null化しても、pitchAccuracyが低ければ
  // 「まず目標音に到達すること」を優先する。
  const { pitchAccuracy } = result.metrics;
  if (pitchAccuracy < REACH_TARGET_ACCURACY) {
    return {
      primaryWeakness: null,
      octaveOff: 0,
      isReliable: true,
      rationale: 'reachTarget',
    };
  }

  // 3b. 全ての非null指標が上級バンドなら「弱点なし」(レビューm-8)。弱点をでっち上げない。
  if (isAllGood(result.metrics)) {
    return {
      primaryWeakness: null,
      octaveOff: 0,
      isReliable: true,
      rationale: 'allGood',
    };
  }

  // 4-5. 通常判定 + ヒステリシス
  return normalDiagnosis(result, history);
}
