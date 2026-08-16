// 音域チェック(Range Check)の解析。正本は docs/TRAINING_MODEL.md「音域チェック(Range Check)」。
// core/ の他モジュール同様 DOM 禁止・純関数のみ。runPipelineOffline の出力(raw/processed、同数・同index対応)を
// 半音ビンに集計し、「がんばれば出せる範囲(full)」と「楽に出せる範囲(comfort)」を求める。
// 2026-08-16 誤測定事故(実ユーザーで「楽な範囲=シ2〜ド#3(幅3半音)」)を受けた再設計:
//   旧設計は (1)ビン資格に250msの滞在が必要=スライドで速く通過した中間音域が全滅
//   (2)連続ビンのみ連結=滞在した端の小塊が最長区間として勝つ (3)基準品質を「出せたビンの
//   中央」から取る=端の小塊が自分自身を基準に合格する循環、の3点が重なり
//   「最後に低音でうなった場所」を楽な範囲と誤認した。
//   対策: 資格150ms化 / 未達ビンの橋渡し(GAP_BRIDGE) / 基準=良い側の四分位に固定 /
//   幅が RANGE_MIN_COMFORT_BINS 未満なら ok=false で正直に失敗を返す。
import type { ProcessedPitchSample, RawPitchSample } from '../types';
import {
  RANGE_BIN_GAP_BRIDGE,
  RANGE_BIN_MIN_MS,
  RANGE_CONF_DROP,
  RANGE_JITTER_FACTOR,
  RANGE_MIN_BINS,
  RANGE_MIN_COMFORT_BINS,
} from '../constants';

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

  // 基準 = 「良い声の側」に固定する(confidenceは上位四分位、ジッターは下位四分位)。
  // 旧実装の「出せたビンの中央寄り」は、端に滞在が偏ると端が自分自身を基準に合格する循環があった。
  const confsAsc = quality.map((b) => b.confMedian).sort((a, b) => a - b);
  const jittersAsc = quality.map((b) => b.jitterMedian ?? 0).sort((a, b) => a - b);
  const baselineConf = confsAsc[Math.min(confsAsc.length - 1, Math.floor(confsAsc.length * 0.75))];
  const baselineJitter = jittersAsc[Math.min(jittersAsc.length - 1, Math.floor(jittersAsc.length * 0.25))];

  const passes = (b: BinQuality): boolean => {
    const confOk = b.confMedian >= baselineConf - RANGE_CONF_DROP;
    const jitterVal = b.jitterMedian ?? 0;
    const jitterOk = jitterVal <= baselineJitter * RANGE_JITTER_FACTOR;
    return confOk && jitterOk;
  };

  // 「楽に出せる範囲」= 基準条件を満たすビンの最長区間。
  // ただし「未達ビン(=速く通過しただけ)」は RANGE_BIN_GAP_BRIDGE 半音まで橋渡しして連続扱い。
  // 品質不合格だった達成ビン(=そこで実際に声が乱れた証拠)を跨ぐ橋渡しはしない。
  let bestLow: number | null = null;
  let bestHigh: number | null = null;
  let runLow: number | null = null;
  let runHigh: number | null = null;
  let failedSinceLastPass = false;

  for (const b of quality) {
    if (!passes(b)) {
      failedSinceLastPass = true;
      continue;
    }
    if (
      runLow === null ||
      runHigh === null ||
      failedSinceLastPass ||
      b.midi - runHigh > RANGE_BIN_GAP_BRIDGE + 1
    ) {
      runLow = b.midi;
      runHigh = b.midi;
    } else {
      runHigh = b.midi;
    }
    failedSinceLastPass = false;
    if (bestLow === null || bestHigh === null || runHigh - runLow > bestHigh - bestLow) {
      bestLow = runLow;
      bestHigh = runHigh;
    }
  }

  // 幅の妥当性ゲート: 「楽な範囲」が狭すぎる結果は誤測定の可能性が高い(端への滞在偏り等)。
  // 自信ありげに間違った狭い範囲を返すより、測定失敗として再測定を促す(fail-loud)。
  if (bestLow === null || bestHigh === null || bestHigh - bestLow + 1 < RANGE_MIN_COMFORT_BINS) {
    return fail;
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
