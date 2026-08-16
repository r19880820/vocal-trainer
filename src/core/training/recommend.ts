// Training Recommendation。正本は docs/TRAINING_MODEL.md「Weakness → Training Recommendation」節。
// training/ は diagnosis の出力(Diagnosis)を実行可能な ExerciseSpec に変換する層
// (ARCHITECTURE.md 依存順序: diagnosis < training)。Scoring/WeaknessDetection とは別モジュール
// (将来 AI Coach に差し替えられるよう、入出力は構造化データのみ)。

import type { Diagnosis, ExerciseResult, ExerciseSpec, TargetNote } from '../types';
import {
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  TARGET_MIDI_MAX,
  TARGET_MIDI_MIN,
  TOWARD_USER_MIDI_MIN,
} from '../constants';

// レビューC-5: UIの src/ui/copy.ts が既に 'allGood' ケースを持つため、型を追加してコンパイルを通す。
export type RecommendationKey =
  | 'octaveOff'
  | 'reachTarget'
  | 'allGood'
  | 'pitchAccuracy'
  | 'pitchStability'
  | 'attackAccuracy'
  | 'retry';

const REACH_TARGET_MAX_SHIFT_SEMITONES = 5;
const REACH_TARGET_FALLBACK_SHIFT_SEMITONES = -3;
const ALLGOOD_SHIFT_SEMITONES = 2;
const STABILITY_DURATION_FACTOR = 1.5;
const ATTACK_DURATION_FACTOR = 0.6;
// ロングトーン変種(pitchStability weak)の phonationMaxMs クランプ範囲。
// TARGET_MIDI_MIN/MAX 等と違い定数表に無い局所的なチューニング値のため、
// (constants.ts は変更禁止のため)このモジュール内定数として定義する(レビューM-4)。
const STABILITY_PHONATION_MAX_CLAMP_MIN_MS = 5000;
const STABILITY_PHONATION_MAX_CLAMP_MAX_MS = 8000;
const STABILITY_PHONATION_MAX_FACTOR = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clampInt(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 目標音を TARGET_MIDI_MIN..TARGET_MIDI_MAX にクランプする(レビューM-5)。 */
function clampMidi(midi: number): number {
  return clampInt(midi, TARGET_MIDI_MIN, TARGET_MIDI_MAX);
}

/**
 * 「ユーザーの声域側へ寄せる」提案(octaveOff/reachTarget)専用のクランプ(レビューN-2)。
 * 通常下限(C3=48)のままだと、低い声のユーザーへの提案が同一specに空振りし
 * 「あなたの声に合わせたお手本で」という文言と矛盾する。ユーザーが実際に出した高さへ
 * 寄せる方向は E2(40)まで許可(F0_MIN=60Hz化により検出可能)。
 */
function clampMidiTowardUser(midi: number): number {
  return clampInt(midi, TOWARD_USER_MIDI_MIN, TARGET_MIDI_MAX);
}

/** durationMs を DURATION_MIN_MS..DURATION_MAX_MS にクランプする(レビューM-4)。 */
function clampDuration(durationMs: number): number {
  return clampInt(durationMs, DURATION_MIN_MS, DURATION_MAX_MS);
}

/**
 * targets[0] とトップレベルの phonationMaxMs を差し替えた新しい ExerciseSpec を作る
 * (残りのフィールドは元specから引き継ぐ)。phonationMaxMs省略時は元specの値を引き継ぐ
 * (レビューM-4: ExerciseEngineが実際に参照するため、変更する場合は明示的に渡す)。
 */
function withSpecPatch(
  spec: ExerciseSpec,
  targetPatch: Partial<TargetNote>,
  phonationMaxMs?: number
): ExerciseSpec {
  return {
    ...spec,
    targets: spec.targets.map((t, i) => (i === 0 ? { ...t, ...targetPatch } : { ...t })),
    phonationMaxMs: phonationMaxMs ?? spec.phonationMaxMs,
  };
}

function withFirstTarget(spec: ExerciseSpec, patch: Partial<TargetNote>): ExerciseSpec {
  return withSpecPatch(spec, patch);
}

function cloneSpec(spec: ExerciseSpec): ExerciseSpec {
  return withFirstTarget(spec, {});
}

/** octaveOff=+1(1オクターブ高く歌った)→ 目標を+12して再挑戦。-1なら-12。TARGET_MIDI範囲にクランプ。 */
function octaveShiftSpec(spec: ExerciseSpec, octaveOff: -1 | 0 | 1): ExerciseSpec {
  const shiftSemitones = octaveOff === 1 ? 12 : octaveOff === -1 ? -12 : 0;
  const target = spec.targets[0];
  return withFirstTarget(spec, { midiNote: clampMidiTowardUser(target.midiNote + shiftSemitones) });
}

/** 弱点なし(allGood): 目標を+2半音(クランプ内)して同型specで再挑戦(レビューC-5)。 */
function allGoodSpec(spec: ExerciseSpec): ExerciseSpec {
  const target = spec.targets[0];
  return withFirstTarget(spec, { midiNote: clampMidi(target.midiNote + ALLGOOD_SHIFT_SEMITONES) });
}

/** durationMs を factor 倍する(DURATION_MIN/MAX_MSにクランプ。レビューM-4)。phonationMaxMsは元specを引き継ぐ。 */
function scaleDurationSpec(spec: ExerciseSpec, factor: number): ExerciseSpec {
  const target = spec.targets[0];
  const durationMs = clampDuration(Math.round(target.durationMs * factor));
  return withFirstTarget(spec, { durationMs });
}

/**
 * pitchStability weak: ロングトーン変種。durationMsを1.5倍(クランプ)し、
 * phonationMaxMsも実際に clamp(durationMs*2, 5000, 8000) へ設定する(レビューM-4)。
 */
function stabilityVariantSpec(spec: ExerciseSpec): ExerciseSpec {
  const target = spec.targets[0];
  const durationMs = clampDuration(Math.round(target.durationMs * STABILITY_DURATION_FACTOR));
  const phonationMaxMs = clampInt(
    durationMs * STABILITY_PHONATION_MAX_FACTOR,
    STABILITY_PHONATION_MAX_CLAMP_MIN_MS,
    STABILITY_PHONATION_MAX_CLAMP_MAX_MS
  );
  return withSpecPatch(spec, { durationMs }, phonationMaxMs);
}

/**
 * reachTarget: 目標をユーザーの voiced 中央値ピッチに最も近い半音へ変更する
 * (最大 ±5半音。ユーザーの発声が全く無ければ単純に-3半音、低い方が出しやすい)。
 * 最終的な目標音は TARGET_MIDI_MIN..MAX にもクランプする(レビューM-5/m-3:
 * ±5半音シフトのクランプと合わせて二重にクランプし、範囲外への逸脱を防ぐ)。
 */
function reachTargetSpec(result: ExerciseResult): ExerciseSpec {
  const spec = result.spec;
  const target = spec.targets[0];
  const originalMidi = Math.round(target.midiNote);

  const voicedMidis = result.samples
    .filter((s) => s.voicing === 'voiced')
    .map((s) => s.midiNote);

  let newMidi: number;
  if (voicedMidis.length > 0) {
    const nearestSemitone = Math.round(median(voicedMidis));
    const shift = clampInt(
      nearestSemitone - originalMidi,
      -REACH_TARGET_MAX_SHIFT_SEMITONES,
      REACH_TARGET_MAX_SHIFT_SEMITONES
    );
    newMidi = originalMidi + shift;
  } else {
    newMidi = originalMidi + REACH_TARGET_FALLBACK_SHIFT_SEMITONES;
  }

  return withFirstTarget(spec, { midiNote: clampMidiTowardUser(newMidi) });
}

/**
 * Diagnosis から実行可能な次の練習 ExerciseSpec を生成する。
 * TRAINING_MODEL.md の提案表どおり、パラメータ違いの ExerciseSpec を作るのみで、
 * spec.exerciseId/levelId/phonationMaxMs/guardAfterPlaybackMs は元specから引き継ぐ。
 */
export function recommend(
  diagnosis: Diagnosis,
  result: ExerciseResult
): { spec: ExerciseSpec; reasonKey: RecommendationKey } {
  // validity 無効 → 同一spec再挑戦
  if (!result.validity.isValid) {
    return { spec: cloneSpec(result.spec), reasonKey: 'retry' };
  }

  // octaveOff != 0 → 弱点判定より優先(diagnose.ts のステップ2と対応)
  if (diagnosis.octaveOff !== 0) {
    return { spec: octaveShiftSpec(result.spec, diagnosis.octaveOff), reasonKey: 'octaveOff' };
  }

  // allGood(diagnose.ts のステップ3b) → primaryWeakness===null だが reachTarget とは区別する
  // 必要があるため、primaryWeakness===null の判定より先に rationale で分岐する(レビューC-5)。
  if (diagnosis.rationale === 'allGood') {
    return { spec: allGoodSpec(result.spec), reasonKey: 'allGood' };
  }

  // primaryWeakness===null かつ ここまでで validity/octaveOff/allGood を除外済みなら reachTarget
  // (diagnose.ts のステップ3。primaryWeakness が null になるのはこの4経路のみという契約に
  // 依拠する — 別モジュールだが diagnose.ts と本ファイルは同一タスクで一緒に実装しているため
  // この契約を前提にできる)。
  if (diagnosis.primaryWeakness === null) {
    return { spec: reachTargetSpec(result), reasonKey: 'reachTarget' };
  }

  switch (diagnosis.primaryWeakness) {
    case 'pitchAccuracy':
      // 同一目標・同一 durationMs で再挑戦(音域を狭める=同じ音でもう一回)
      return { spec: cloneSpec(result.spec), reasonKey: 'pitchAccuracy' };
    case 'pitchStability':
      // ロングトーン変種: durationMs を1.5倍(クランプ)。phonationMaxMsも実際に再設定する(レビューM-4)。
      return {
        spec: stabilityVariantSpec(result.spec),
        reasonKey: 'pitchStability',
      };
    case 'attackAccuracy':
      // 短音アタック変種: durationMs を0.6倍(クランプ)
      return {
        spec: scaleDurationSpec(result.spec, ATTACK_DURATION_FACTOR),
        reasonKey: 'attackAccuracy',
      };
    default:
      // diagnose.ts の5ステップ契約上は到達しない(primaryWeakness は BANDS の3種のみを返す)。
      // 型上は keyof ExerciseMetrics 全体が許容されるための防御的フォールバック。
      // レビューm-4: validity=ok で 'retry' に落ちる経路を排除するため、未知キーは
      // pitchAccuracy相当(同一spec再挑戦)として扱う('retry' は validity無効時専用に一本化)。
      return { spec: cloneSpec(result.spec), reasonKey: 'pitchAccuracy' };
  }
}
