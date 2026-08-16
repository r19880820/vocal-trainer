// 録音・再生ハーネスの解析入口。正本は docs/ROADMAP.md Phase 1 宿題 / AGENTS.md「実録音の回帰」。
// 実ストリーム(platform/pitchWorker.ts)と同一構成・同一定数で
// HalfbandDecimator → OnePoleHighpass → YinDetector → PitchProcessor を通す純TS関数。
// 「同じ録音を再投入して回帰テストする」ための土台(閾値較正・起動時セルフテストの両方から使う)。
//
// core/ は DOM 禁止のため、録音の取得(platform/audioSession.ts)・WAVエンコード(platform/wav.ts)
// はこのファイルの責務外。ここは Float32Array の PCM を受け取るだけの純関数。

import type { ProcessedPitchSample, RawPitchSample } from './types';
import { HalfbandDecimator } from './audio/halfband';
import { OnePoleHighpass } from './audio/highpass';
import { YinDetector } from './pitch/yin';
import { PitchProcessor } from './processing/processor';
import { HPF_CUTOFF_HZ, INTERNAL_RATE_DIVISOR, NOISE_MEASURE_MS, YIN_HOP } from './constants';

export interface OfflinePipelineResult {
  raw: RawPitchSample[];
  processed: ProcessedPitchSample[];
}

/**
 * 録音済みPCM(mono, contextSampleRate基準)を実ストリームと同一パイプラインで解析する。
 *
 * noiseFloorは呼び出し側から渡せない(実ストリームのように別フェーズの500ms測定が無いオフライン用途の
 * ため)ので、録音先頭 NOISE_MEASURE_MS(500ms)の RawPitchSample.amplitude から自動推定する:
 * 有限dB(amplitude>0)の値の中央値。1件も無ければ -80dBFS にフォールバックする。
 * この推定値を録音全体(先頭500ms自身を含む)の voicing 判定に使う — 実ストリームの
 * 「ノイズ測定→本番」の2段階を1本の録音で近似する簡略化であり、較正時の録音は必ず
 * 発声/再生前に無音〜低振幅の助走区間を含めること(起動時セルフテストの録音タップONは
 * 440Hzトーン再生前から始まるため、この前提を満たす)。
 *
 * デシメータ/ハイパスはブロック分割で処理してもワンショットで処理しても同一結果になる
 * (core/audio/halfband.ts, core/audio/highpass.ts のクラスコメント参照)ため、
 * 実ストリーム(pitchWorker.ts)のような分割逐次処理ではなく録音全体を一括で通す。
 */
export function runPipelineOffline(pcm: Float32Array, contextSampleRate: number): OfflinePipelineResult {
  if (!(contextSampleRate > 0)) {
    throw new Error(`runPipelineOffline: invalid contextSampleRate (${String(contextSampleRate)})`);
  }

  const internalRate = contextSampleRate / INTERNAL_RATE_DIVISOR;

  const decimator = new HalfbandDecimator();
  const highpass = new OnePoleHighpass(internalRate, HPF_CUTOFF_HZ);
  const detector = new YinDetector(internalRate);
  const processor = new PitchProcessor(internalRate);

  const decimated = highpass.process(decimator.process(pcm));

  const raw: RawPitchSample[] = [];
  let offset = 0;
  while (decimated.length - offset >= YIN_HOP) {
    const hop = decimated.subarray(offset, offset + YIN_HOP);
    const sample = detector.push(hop);
    if (sample) raw.push(sample);
    offset += YIN_HOP;
  }
  // YINは遅延出力を持たないため常に[]だが、将来pYINへ差し替え可能な契約(ARCHITECTURE.md)に
  // 合わせてflush()も呼んでおく。
  raw.push(...detector.flush());

  processor.setNoiseFloorDb(estimateNoiseFloorDb(raw));
  const processed = raw.map((r) => processor.process(r));

  return { raw, processed };
}

/** 先頭 NOISE_MEASURE_MS の raw から有限dBの中央値を推定する。無ければ -80dBFS。 */
function estimateNoiseFloorDb(raw: RawPitchSample[]): number {
  const dbValues: number[] = [];
  for (const r of raw) {
    if (r.timestampMs > NOISE_MEASURE_MS) break; // raw は timestampMs 昇順
    if (r.amplitude > 0) {
      const db = 20 * Math.log10(r.amplitude);
      if (Number.isFinite(db)) dbValues.push(db);
    }
  }
  if (dbValues.length === 0) return -80;
  return median(dbValues);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
