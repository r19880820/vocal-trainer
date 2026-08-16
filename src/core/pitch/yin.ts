// YIN ピッチ検出器。正本は docs/AUDIO_ANALYSIS.md §2 / ADR-001。
// ストリーム型 PitchDetector interface(ARCHITECTURE.md)。YINは遅延出力を持たないため
// push() はバッファ充足後は毎回サンプルを返し、flush() は常に [] を返す。

import type { PitchDetector, RawPitchSample } from '../types';
import { F0_MAX_HZ, F0_MIN_HZ, YIN_THRESHOLD, YIN_WINDOW } from '../constants';

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** 今回push分(hop)のRMS。hop自身の平均値を除去してから算出する。 */
function computeHopRms(hop: Float32Array): number {
  const n = hop.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += hop[i];
  mean /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = hop[i] - mean;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / n);
}

/**
 * τドメインでの放物線補間(CMNDFの隣接3点)。境界(τ<=0 または τ>=tauMax)では
 * 補間に必要な片側の点が無いため整数τをそのまま返す。
 */
function parabolicInterpolateTau(cmndf: Float64Array, tau: number, tauMax: number): number {
  if (tau <= 0 || tau >= tauMax) {
    return tau;
  }
  const y0 = cmndf[tau - 1];
  const y1 = cmndf[tau];
  const y2 = cmndf[tau + 1];
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) {
    return tau;
  }
  let shift = (0.5 * (y0 - y2)) / denom;
  if (shift > 1) shift = 1;
  if (shift < -1) shift = -1;
  return tau + shift;
}

export class YinDetector implements PitchDetector {
  private readonly fs: number;
  private readonly tauMin: number;
  private readonly tauMax: number;
  private readonly bufferSize: number; // N = W + tauMax
  private readonly buffer: Float32Array;
  private readonly diff: Float64Array; // index 0..tauMax
  private readonly cmndf: Float64Array; // index 0..tauMax
  private cumulativeSamples: number;
  private filled: boolean;

  constructor(internalSampleRate: number) {
    this.fs = internalSampleRate;
    this.tauMin = Math.ceil(this.fs / F0_MAX_HZ);
    this.tauMax = Math.floor(this.fs / F0_MIN_HZ);

    // 不変条件 W >= 2*tauMax(AUDIO_ANALYSIS.md §1)。違反時は fail-loud。
    if (YIN_WINDOW < 2 * this.tauMax) {
      throw new Error(
        `YinDetector: invariant violated — YIN_WINDOW (${YIN_WINDOW}) must be >= 2*tauMax ` +
          `(tauMax=${this.tauMax} at internalSampleRate=${this.fs}Hz, F0_MIN_HZ=${F0_MIN_HZ})`
      );
    }

    this.bufferSize = YIN_WINDOW + this.tauMax;
    this.buffer = new Float32Array(this.bufferSize);
    this.diff = new Float64Array(this.tauMax + 1);
    this.cmndf = new Float64Array(this.tauMax + 1);
    this.cumulativeSamples = 0;
    this.filled = false;
  }

  reset(): void {
    this.buffer.fill(0);
    this.cumulativeSamples = 0;
    this.filled = false;
  }

  push(hop: Float32Array): RawPitchSample | null {
    const hopLen = hop.length;
    const bufferSize = this.bufferSize;

    // リングバッファをスライドし、新しいサンプルを末尾に追加する。
    if (hopLen >= bufferSize) {
      this.buffer.set(hop.subarray(hopLen - bufferSize));
    } else if (hopLen > 0) {
      this.buffer.copyWithin(0, hopLen);
      this.buffer.set(hop, bufferSize - hopLen);
    }

    this.cumulativeSamples += hopLen;

    if (!this.filled) {
      if (this.cumulativeSamples < bufferSize) {
        return null;
      }
      this.filled = true;
    }

    const amplitude = computeHopRms(hop);
    const sampleIndex = this.cumulativeSamples;
    const timestampMs = (sampleIndex / this.fs) * 1000;

    const W = YIN_WINDOW;
    const tauMax = this.tauMax;
    const tauMin = this.tauMin;
    const buf = this.buffer;
    const d = this.diff;
    const cmndf = this.cmndf;

    // 差分関数 d(τ) = Σ_{j=0}^{W-1} (x[j] - x[j+τ])²
    d[0] = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const delta = buf[j] - buf[j + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    // CMNDF(累積平均正規化差分関数)
    cmndf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      cmndf[tau] = runningSum === 0 ? 1 : (d[tau] * tau) / runningSum;
    }

    if (runningSum === 0) {
      // 退化ケース: 解析窓+ルックアヘッド全域が定数(無音等)で周期性を測定不能。
      // 0 = 候補なし の扱いに含める(バッファ未充足と同様の「解析対象なし」)。
      return {
        sampleIndex,
        timestampMs,
        frequencyHz: 0,
        belowThreshold: false,
        confidence: 0,
        amplitude,
      };
    }

    // 絶対閾値ステップ(YIN原典): 閾値を下回る最初のτの局所最小を採用。
    let selectedTau = -1;
    let belowThreshold = false;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < YIN_THRESHOLD) {
        let t = tau;
        while (t + 1 <= tauMax && cmndf[t + 1] < cmndf[t]) {
          t++;
        }
        selectedTau = t;
        belowThreshold = true;
        break;
      }
    }

    if (selectedTau === -1) {
      // 存在しなければ [tauMin, tauMax] の大域最小を採用。
      let bestTau = tauMin;
      let bestVal = cmndf[tauMin];
      for (let tau = tauMin + 1; tau <= tauMax; tau++) {
        if (cmndf[tau] < bestVal) {
          bestVal = cmndf[tau];
          bestTau = tau;
        }
      }
      selectedTau = bestTau;
      belowThreshold = false;
    }

    // τ張り付きの fail-loud(レビューC-1 / AUDIO_ANALYSIS.md §2): 採用した整数τが
    // 探索上限(tauMax)直下(tauMax-1以上)なら、探索下限未満のF0を誤って探索上限に
    // 張り付かせている可能性がある。無言でそれらしい値を出さず belowThreshold=false にする。
    if (selectedTau >= tauMax - 1) {
      belowThreshold = false;
    }

    // 放物線補間はτドメイン(f = fs/τ̂ を後で計算)。
    const refinedTau = parabolicInterpolateTau(cmndf, selectedTau, tauMax);
    const frequencyHz = this.fs / refinedTau;
    // confidence は補間前の整数τにおけるCMNDF値を使用(補間は周波数のみに適用)。
    const confidence = clamp01(1 - cmndf[selectedTau]);

    return {
      sampleIndex,
      timestampMs,
      frequencyHz,
      belowThreshold,
      confidence,
      amplitude,
    };
  }

  flush(): RawPitchSample[] {
    // YINは遅延出力を持たない(状態なし、push即返し)。
    return [];
  }
}
