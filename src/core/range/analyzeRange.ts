// 音域チェック(Range Check)の解析。正本は docs/TRAINING_MODEL.md「音域チェック(Range Check)」。
// core/ の他モジュール同様 DOM 禁止・純関数のみ。runPipelineOffline の出力(raw/processed、同数・同index対応)を
// 半音ビンに集計し、「がんばれば出せる範囲(full)」と「楽に出せる範囲(comfort)」を求める。
import type { ProcessedPitchSample, RawPitchSample } from '../types';
import { RANGE_BIN_MIN_MS, RANGE_CONF_DROP, RANGE_JITTER_FACTOR, RANGE_MIN_BINS } from '../constants';

export interface VocalRangeResult {
  fullLowMidi: number | null; // がんばれば(全力範囲)
  fullHighMidi: number | null;
  comfortLowMidi: number | null; // 楽に出せる範囲
  comfortHighMidi: number | null;
  ok: boolean; // 出せたビン >= RANGE_MIN_BINS
}

interface BinAgg {
  midi: number;
  voicedMs: number;
  /** raw.confidence(voicedサンプルのみ) */
  confidences: number[];
  /** そのビンに属するサンプルの実数midiNote(このビンに来た時系列順) — ジッター算出用 */
  values: number[];
}

interface BinQuality {
  midi: number;
  confMedian: number;
  /** ビン内で隣接ペアが1組も無ければ null(揺れの証拠なし=閾値判定では0扱い) */
  jitterMedian: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** サンプル間の名目ホップ長(ms)。連続する正のtimestampMs差の中央値で近似する
 * (2パス分の raw/processed を連結して渡す運用のため、パス境界のtimestampMs逆行/リセットは
 * 正の差のみを候補にすることで自然に除外される)。 */
function nominalStepMs(processed: ProcessedPitchSample[]): number {
  const deltas: number[] = [];
  for (let i = 0; i < processed.length - 1; i++) {
    const d = processed[i + 1].timestampMs - processed[i].timestampMs;
    if (d > 0) deltas.push(d);
  }
  const m = median(deltas);
  return m !== null && m > 0 ? m : 12; // フォールバック(約86Hz更新相当。AUDIO_ANALYSIS.md §1のホップ長目安)
}

export function analyzeVocalRange(
  raw: RawPitchSample[],
  processed: ProcessedPitchSample[]
): VocalRangeResult {
  const fail: VocalRangeResult = {
    fullLowMidi: null,
    fullHighMidi: null,
    comfortLowMidi: null,
    comfortHighMidi: null,
    ok: false,
  };

  // raw/processed は同数・同index対応が契約(runPipelineOffline)だが、防御的に短い方に合わせる。
  const n = Math.min(raw.length, processed.length);
  if (n === 0) return fail;

  const step = nominalStepMs(processed);
  const bins = new Map<number, BinAgg>();

  for (let i = 0; i < n; i++) {
    const p = processed[i];
    if (p.voicing !== 'voiced') continue;
    const midiBin = Math.round(p.midiNote);
    let agg = bins.get(midiBin);
    if (!agg) {
      agg = { midi: midiBin, voicedMs: 0, confidences: [], values: [] };
      bins.set(midiBin, agg);
    }
    const next = i + 1 < n ? processed[i + 1].timestampMs : NaN;
    const delta = next - p.timestampMs;
    const dur = delta > 0 && delta < step * 4 ? delta : step;
    agg.voicedMs += dur;
    agg.confidences.push(raw[i].confidence);
    agg.values.push(p.midiNote);
  }

  // 「出せたビン」= 有声時間 >= RANGE_BIN_MIN_MS
  const achieved = [...bins.values()].filter((b) => b.voicedMs >= RANGE_BIN_MIN_MS);
  if (achieved.length < RANGE_MIN_BINS) return fail;

  const sortedAchieved = [...achieved].sort((a, b) => a.midi - b.midi);
  const fullLowMidi = sortedAchieved[0].midi;
  const fullHighMidi = sortedAchieved[sortedAchieved.length - 1].midi;

  // ビンごとの品質(confidence中央値・ジッター中央値)
  const quality: BinQuality[] = sortedAchieved.map((b) => ({
    midi: b.midi,
    confMedian: median(b.confidences) ?? 0,
    jitterMedian: jitterOfBin(b.values),
  }));

  // 基準 = 出せたビンのうち中央寄り(低い方から25〜75%位置)の品質中央値
  const L = quality.length;
  const startIdx = Math.floor(L * 0.25);
  const endIdx = Math.max(startIdx, Math.ceil(L * 0.75) - 1);
  const central = quality.slice(startIdx, endIdx + 1);
  const baselineConf = median(central.map((b) => b.confMedian)) ?? 0;
  const baselineJitter = median(central.map((b) => b.jitterMedian ?? 0)) ?? 0;

  const passes = (b: BinQuality): boolean => {
    const confOk = b.confMedian >= baselineConf - RANGE_CONF_DROP;
    const jitterVal = b.jitterMedian ?? 0;
    const jitterOk = jitterVal <= baselineJitter * RANGE_JITTER_FACTOR;
    return confOk && jitterOk;
  };

  // 「楽に出せる範囲」= 基準条件を満たす連続(半音隣接)ビンの最長区間
  let bestLow: number | null = null;
  let bestHigh: number | null = null;
  let curLow: number | null = null;
  let curHigh: number | null = null;
  let prevMidi: number | null = null;
  let prevPassed = false;

  for (const b of quality) {
    const ok = passes(b);
    if (ok) {
      const contiguous = prevPassed && prevMidi !== null && b.midi === prevMidi + 1;
      if (contiguous && curLow !== null) {
        curHigh = b.midi;
      } else {
        curLow = b.midi;
        curHigh = b.midi;
      }
      if (bestLow === null || bestHigh === null || curHigh - curLow > bestHigh - bestLow) {
        bestLow = curLow;
        bestHigh = curHigh;
      }
    } else {
      curLow = null;
      curHigh = null;
    }
    prevMidi = b.midi;
    prevPassed = ok;
  }

  return {
    fullLowMidi,
    fullHighMidi,
    comfortLowMidi: bestLow,
    comfortHighMidi: bestHigh,
    ok: true,
  };
}

/** ビン内の実数midiNote列(そのビンに来た時系列順)から隣接差(cent)の中央値を求める。
 * 「同一ビン内の時系列で隣接するvoicedサンプルの|Δcent|中央値」(TRAINING_MODEL.md)。 */
function jitterOfBin(values: number[]): number | null {
  if (values.length < 2) return null;
  const deltasCents: number[] = [];
  for (let i = 1; i < values.length; i++) {
    deltasCents.push(Math.abs(values[i] - values[i - 1]) * 100);
  }
  return median(deltasCents);
}
