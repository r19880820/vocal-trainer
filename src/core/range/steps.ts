// 音域チェック(Range Check)v2「音についていく方式」のステップ判定。正本は
// docs/TRAINING_MODEL.md「音域チェック(Range Check)」。core/ の他モジュール同様 DOM 禁止・純関数のみ。
// アプリがお手本を1音ずつ再生し、各音への滞在時間(捕捉)を制御する設計のため、
// 判定はステップ単位の閾値比較のみでよい(旧 analyzeRange.ts のビン集計・グリッサンド解析は
// 自由スライド前提だったため v2 で廃止 — TRAINING_MODEL.md 履歴メモ参照)。
import type { ProcessedPitchSample } from '../types';
import { RANGE_STEP_COMFORT_CENTS, RANGE_STEP_MATCH_CENTS, RANGE_STEP_MIN_VOICED_MS } from '../constants';

export interface StepEvaluation {
  /** 有声時間 >= RANGE_STEP_MIN_VOICED_MS かつ |目標比cents中央値| <= RANGE_STEP_MATCH_CENTS */
  matched: boolean;
  /** matched かつ |目標比cents中央値| <= RANGE_STEP_COMFORT_CENTS */
  comfortable: boolean;
  /** voicedサンプルの (実数midiNote - targetMidi) * 100 の中央値。voicedサンプルが1件も無ければ null */
  medianCents: number | null;
  /** voicedサンプルの有声時間合計(ms) */
  voicedMs: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** サンプル間の名目ホップ長(ms)。連続する正のtimestampMs差の中央値で近似する
 * (analyzeRange.ts の同名関数と同じ考え方 — 末尾サンプルの有声時間見積りに使う)。 */
function nominalStepMs(processed: ProcessedPitchSample[]): number {
  const deltas: number[] = [];
  for (let i = 0; i < processed.length - 1; i++) {
    const d = processed[i + 1].timestampMs - processed[i].timestampMs;
    if (d > 0) deltas.push(d);
  }
  const m = median(deltas);
  return m !== null && m > 0 ? m : 12; // フォールバック(約86Hz更新相当。AUDIO_ANALYSIS.md §1のホップ長目安)
}

/**
 * 1ステップ分の処理済みサンプル(静音区間を除いた捕捉区間。呼び出し側で先頭の静音分を
 * 除外してから渡すこと)から matched/comfortable を判定する。
 * cents は (実数midiNote - targetMidi) * 100 で算出する(processed の midiNote は ForScoring 由来)。
 */
export function evaluateStep(processed: ProcessedPitchSample[], targetMidi: number): StepEvaluation {
  const step = nominalStepMs(processed);
  let voicedMs = 0;
  const centsValues: number[] = [];
  for (let i = 0; i < processed.length; i++) {
    const p = processed[i];
    if (p.voicing !== 'voiced') continue;
    const next = i + 1 < processed.length ? processed[i + 1].timestampMs : NaN;
    const delta = next - p.timestampMs;
    const dur = delta > 0 && delta < step * 4 ? delta : step;
    voicedMs += dur;
    centsValues.push((p.midiNote - targetMidi) * 100);
  }
  const medianCents = median(centsValues);
  const absCents = medianCents === null ? null : Math.abs(medianCents);
  const matched = voicedMs >= RANGE_STEP_MIN_VOICED_MS && absCents !== null && absCents <= RANGE_STEP_MATCH_CENTS;
  const comfortable = matched && absCents !== null && absCents <= RANGE_STEP_COMFORT_CENTS;
  return { matched, comfortable, medianCents, voicedMs };
}

export interface RangeStepsResult {
  comfortLowMidi: number | null;
  comfortHighMidi: number | null;
  fullLowMidi: number | null;
  fullHighMidi: number | null;
  /** matched なステップが1つも無ければ false(測定失敗) */
  ok: boolean;
}

/**
 * 下降/上昇パスの各ステップ評価を集計する。
 * comfortable だったステップの目標音の最低〜最高 → comfort、
 * matched だったステップの目標音の最低〜最高 → full。
 */
export function aggregateSteps(steps: Array<{ targetMidi: number; eval: StepEvaluation }>): RangeStepsResult {
  const matchedMidis = steps.filter((s) => s.eval.matched).map((s) => s.targetMidi);
  if (matchedMidis.length === 0) {
    return { comfortLowMidi: null, comfortHighMidi: null, fullLowMidi: null, fullHighMidi: null, ok: false };
  }
  const comfortMidis = steps.filter((s) => s.eval.comfortable).map((s) => s.targetMidi);
  return {
    fullLowMidi: Math.min(...matchedMidis),
    fullHighMidi: Math.max(...matchedMidis),
    comfortLowMidi: comfortMidis.length > 0 ? Math.min(...comfortMidis) : null,
    comfortHighMidi: comfortMidis.length > 0 ? Math.max(...comfortMidis) : null,
    ok: true,
  };
}
