// Exercise 採点。正本は docs/AUDIO_ANALYSIS.md §5(評価指標の定義)。
// MVP は spec.targets[0] のみ対象(Level 2)。scoring/ は features の出力を指標に変換する層
// (ARCHITECTURE.md 依存順序: features < scoring)。

import type {
  ExerciseMetrics,
  ExerciseResult,
  ExerciseSpec,
  ProcessedPitchSample,
  ValidityReason,
} from '../types';
import {
  ATTACK_NORM_S,
  OCTAVE_OFF_TOLERANCE_CENTS,
  PARAMS_VERSION,
  PITCH_OK_CENTS,
  STABILITY_MIN_MS,
  STABILITY_SIGMA_NORM_CENTS,
  VALID_MIN_VOICED_MS,
} from '../constants';
import { analyzePhonation, centsVsTarget, sampleDurationsMs } from '../features/segment';

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * サンプル列から ExerciseResult を算出する純関数。呼び出し側が timestamp を渡す。
 */
export function scoreExercise(
  samples: ProcessedPitchSample[],
  spec: ExerciseSpec,
  timestamp: number
): ExerciseResult {
  const targetMidi = spec.targets[0].midiNote;
  const phonation = analyzePhonation(samples);
  const durations = sampleDurationsMs(samples);

  const validity = determineValidity(samples, durations, phonation);

  const voicedIdx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing === 'voiced') voicedIdx.push(i);
  }

  const rawCents = new Map<number, number>();
  for (const i of voicedIdx) {
    rawCents.set(i, centsVsTarget(samples[i], targetMidi));
  }

  const octaveOff = detectOctaveOff(voicedIdx, rawCents, durations);

  // octaveOff != 0 のとき、pitchAccuracy系(pitchAccuracy/medianAbsCents/attackAccuracy/
  // pitchStability)は「高さの感覚は合っている」を正しく評価するため、オクターブ補正後の
  // cents(cents∓1200)で算出する。TRAINING_MODEL.md の octaveOff 診断文言(音の高さの感覚は
  // 合っている+1オクターブ下/上で歌っている)と整合させる実装判断(詳細は最終報告)。
  const octaveShiftCents = octaveOff === 1 ? -1200 : octaveOff === -1 ? 1200 : 0;
  const correctedCents = new Map<number, number>();
  for (const i of voicedIdx) {
    correctedCents.set(i, rawCents.get(i)! + octaveShiftCents);
  }

  const metrics = computeMetrics(samples, durations, voicedIdx, correctedCents, phonation.onsetMs);

  return {
    spec,
    timestamp,
    paramsVersion: PARAMS_VERSION,
    validity,
    metrics,
    octaveOff,
    samples,
  };
}

/**
 * validity判定(レビューM-1再設計。正本は AUDIO_ANALYSIS.md §5):
 *   1. voicedMs >= VALID_MIN_VOICED_MS → ok
 *   2. それ未満で、active区間(最初〜最後の非silentサンプルの間)内の tooQuiet+unclear
 *      合計時間 >= VALID_MIN_VOICED_MS → tooQuiet
 *   3. それ以外 → tooShort
 * 分母を録音全体にしない(発声前の待ち時間の長さで判定が変わらないように — test-retest 保護)。
 * 旧ロジック(TOO_QUIET_DOMINANT_RATIO=全サンプル比30%)は廃止。
 */
function determineValidity(
  samples: ProcessedPitchSample[],
  durations: number[],
  phonation: { voicedMs: number }
): { isValid: boolean; reason: ValidityReason } {
  if (samples.length === 0) {
    return { isValid: false, reason: 'tooShort' };
  }

  if (phonation.voicedMs >= VALID_MIN_VOICED_MS) {
    return { isValid: true, reason: 'ok' };
  }

  // active区間 = 最初の非silentサンプル 〜 最後の非silentサンプル(inclusive)。
  let firstActive = -1;
  let lastActive = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing !== 'silent') {
      if (firstActive === -1) firstActive = i;
      lastActive = i;
    }
  }

  if (firstActive !== -1) {
    let tooQuietUnclearMs = 0;
    for (let i = firstActive; i <= lastActive; i++) {
      if (samples[i].voicing === 'tooQuiet' || samples[i].voicing === 'unclear') {
        tooQuietUnclearMs += durations[i];
      }
    }
    if (tooQuietUnclearMs >= VALID_MIN_VOICED_MS) {
      return { isValid: false, reason: 'tooQuiet' };
    }
  }

  return { isValid: false, reason: 'tooShort' };
}

/**
 * octaveOff 判定。AUDIO_ANALYSIS.md §5 は「有声時間の過半」(時間ベース)と定義しており、
 * pitchAccuracy の時間ベース定義と整合させるためこちらも時間重み付きで判定する
 * (タスク仕様書の文言は「voiced サンプルの過半」だが、AUDIO_ANALYSIS.md §5 を指標定義の
 * 正本として優先した。ほぼ均一なホップ間隔ではサンプル数比と時間比は一致するため実質的な
 * 差は出ない。最終報告で指摘)。
 */
function detectOctaveOff(
  voicedIdx: number[],
  rawCents: Map<number, number>,
  durations: number[]
): -1 | 0 | 1 {
  let voicedTimeMs = 0;
  let highTimeMs = 0;
  let lowTimeMs = 0;
  for (const i of voicedIdx) {
    voicedTimeMs += durations[i];
    const c = rawCents.get(i)!;
    if (Math.abs(c - 1200) <= OCTAVE_OFF_TOLERANCE_CENTS) highTimeMs += durations[i];
    if (Math.abs(c + 1200) <= OCTAVE_OFF_TOLERANCE_CENTS) lowTimeMs += durations[i];
  }
  if (voicedTimeMs <= 0) return 0;
  if (highTimeMs / voicedTimeMs > 0.5) return 1;
  if (lowTimeMs / voicedTimeMs > 0.5) return -1;
  return 0;
}

function computeMetrics(
  samples: ProcessedPitchSample[],
  durations: number[],
  voicedIdx: number[],
  correctedCents: Map<number, number>,
  onsetMs: number | null
): ExerciseMetrics {
  // pitchAccuracy: 有声時間のうち |cents| <= PITCH_OK_CENTS だった割合(時間重み付き)
  let voicedTimeMs = 0;
  let okTimeMs = 0;
  for (const i of voicedIdx) {
    voicedTimeMs += durations[i];
    if (Math.abs(correctedCents.get(i)!) <= PITCH_OK_CENTS) okTimeMs += durations[i];
  }
  const pitchAccuracy = voicedTimeMs > 0 ? okTimeMs / voicedTimeMs : 0;

  // medianAbsCents: 有声区間の |cents| 中央値
  const absCentsValues = voicedIdx.map((i) => Math.abs(correctedCents.get(i)!));
  const medianAbsCents = median(absCentsValues);

  // 最初に |cents| <= PITCH_OK_CENTS に入った voiced サンプル(onset 以降)を探す。
  let reachIdx: number | null = null;
  if (onsetMs !== null) {
    for (const i of voicedIdx) {
      if (samples[i].timestampMs < onsetMs) continue;
      if (Math.abs(correctedCents.get(i)!) <= PITCH_OK_CENTS) {
        reachIdx = i;
        break;
      }
    }
  }

  // attackAccuracy: onset → 初到達までの時間 t → clamp(1 - t/ATTACK_NORM_S, 0, 1)。
  // 一度も入らなければ null(0にしない)。
  let attackAccuracy: number | null = null;
  if (onsetMs !== null && reachIdx !== null) {
    const tSec = (samples[reachIdx].timestampMs - onsetMs) / 1000;
    attackAccuracy = clamp(1 - tSec / ATTACK_NORM_S, 0, 1);
  }

  // pitchStability: 初到達以降の voiced サンプルの cents 標準偏差 → clamp(1 - σ/NORM, 0, 1)。
  // 到達なしなら null。到達後の voiced 時間の合計 < STABILITY_MIN_MS も null
  // (1サンプルのみでσ=0→「とても安定」と誤って褒めるのを防ぐ — レビューC-2)。
  let pitchStability: number | null = null;
  if (reachIdx !== null) {
    const stableIdx = voicedIdx.filter((i) => i >= reachIdx!);
    const stableVoicedMs = stableIdx.reduce((sum, i) => sum + durations[i], 0);
    if (stableVoicedMs >= STABILITY_MIN_MS) {
      const stableCents = stableIdx.map((i) => correctedCents.get(i)!);
      const sigma = stddev(stableCents);
      pitchStability = clamp(1 - sigma / STABILITY_SIGMA_NORM_CENTS, 0, 1);
    }
  }

  return {
    pitchAccuracy,
    medianAbsCents,
    pitchStability,
    attackAccuracy,
  };
}
