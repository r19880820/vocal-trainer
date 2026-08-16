// ハーフバンド÷2デシメータ。正本は docs/AUDIO_ANALYSIS.md §1
// (内部レート = 実レート÷2。÷2以外の有理リサンプルは自前実装しない)。
// 線形位相FIRローパス(窓法・Hammingウィンドウ、カットオフ≈入力fsの1/4)+2:1間引き。
// ブロック跨ぎの状態(フィルタ史・間引き位相)を保持し、任意長の入力ブロック(奇数長含む)に対応する。

const NUM_TAPS = 63; // 奇数(Type I 線形位相)。31〜63の範囲内、精度寄りで上限側を採用
const CUTOFF_NORM = 0.23; // カットオフ/fs。fs/4(=0.25)よりわずかに低く遷移帯域の余裕を確保

function designLowpass(numTaps: number, cutoffNorm: number): Float32Array {
  const m = numTaps - 1;
  const h = new Float64Array(numTaps);
  for (let n = 0; n < numTaps; n++) {
    const k = n - m / 2;
    const sincVal =
      k === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * k) / (Math.PI * k);
    // Hamming window
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / m);
    h[n] = sincVal * w;
  }
  // DCゲインを1に正規化
  let sum = 0;
  for (let n = 0; n < numTaps; n++) sum += h[n];
  const out = new Float32Array(numTaps);
  for (let n = 0; n < numTaps; n++) out[n] = h[n] / sum;
  return out;
}

const TAPS = designLowpass(NUM_TAPS, CUTOFF_NORM);

export class HalfbandDecimator {
  private readonly taps: Float32Array;
  private readonly historyLen: number;
  private readonly history: Float32Array;
  /** これまでに process() へ渡された入力サンプルの累積数(間引き位相の基準)。 */
  private globalIndex: number;

  constructor() {
    this.taps = TAPS;
    this.historyLen = this.taps.length - 1;
    this.history = new Float32Array(this.historyLen);
    this.globalIndex = 0;
  }

  /**
   * 入力を線形位相FIRローパスに通し、2:1間引きした出力を返す。
   * フィルタ史と間引き位相はインスタンスに保持されるため、任意長(奇数長含む)の
   * ブロックに分割して連続して呼んでも、1回で渡した場合と同じ結果になる。
   */
  process(input: Float32Array): Float32Array {
    const numTaps = this.taps.length;
    const historyLen = this.historyLen;
    const inputLen = input.length;

    const extended = new Float32Array(historyLen + inputLen);
    extended.set(this.history, 0);
    extended.set(input, historyLen);

    const maxOut = Math.floor(inputLen / 2) + 1;
    const out = new Float32Array(maxOut);
    let outCount = 0;

    const taps = this.taps;
    for (let j = 0; j < inputLen; j++) {
      const globalIdx = this.globalIndex + j;
      if (globalIdx % 2 !== 0) continue;
      const base = historyLen + j;
      let acc = 0;
      for (let k = 0; k < numTaps; k++) {
        acc += taps[k] * extended[base - k];
      }
      out[outCount++] = acc;
    }

    // フィルタ史を更新: 直近 historyLen サンプルを保持する
    if (historyLen > 0) {
      this.history.set(extended.subarray(extended.length - historyLen));
    }

    this.globalIndex += inputLen;

    return out.subarray(0, outCount);
  }

  /** フィルタ史・間引き位相・累積サンプル数をリセットする。 */
  reset(): void {
    this.history.fill(0);
    this.globalIndex = 0;
  }
}
