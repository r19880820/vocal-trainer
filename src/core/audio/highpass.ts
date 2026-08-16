// 1次IIRハイパスフィルタ。正本は docs/AUDIO_ANALYSIS.md §3 step0
// (DC除去+ハイパス50Hz、探索下限80Hzより下)。RMSはこのフィルタ適用後に計測する
// (息の吹かれ・手持ちノイズによるgate誤通過を防ぐ)。
//
// RC回路の標準的な離散近似(差分方程式):
//   y[n] = alpha * (y[n-1] + x[n] - x[n-1])
//   alpha = RC / (RC + dt) = 1 / (1 + 2*pi*cutoffHz/sampleRate)
// これは1極1零(零点はDC、z=1)の伝達関数 H(z) = alpha*(1-z^-1)/(1-alpha*z^-1) に等しく、
// 6dB/oct のロールオフを持つ「1次」ハイパスの標準形(z変換すると容易に確認できる)。
//
// 前回サンプルの入力・出力値のみをインスタンスに保持し、ブロック跨ぎで連続動作する。

export class OnePoleHighpass {
  private readonly alpha: number;
  private prevInput = 0;
  private prevOutput = 0;

  constructor(sampleRate: number, cutoffHz: number) {
    if (!(sampleRate > 0)) {
      throw new Error(`OnePoleHighpass: sampleRate must be positive (got ${sampleRate})`);
    }
    if (!(cutoffHz > 0)) {
      throw new Error(`OnePoleHighpass: cutoffHz must be positive (got ${cutoffHz})`);
    }
    this.alpha = 1 / (1 + (2 * Math.PI * cutoffHz) / sampleRate);
  }

  /** ブロックにハイパスを適用し、新しい配列を返す(入力は破壊しない)。状態はブロック跨ぎで保持する。 */
  process(block: Float32Array): Float32Array {
    const out = new Float32Array(block.length);
    const alpha = this.alpha;
    let prevInput = this.prevInput;
    let prevOutput = this.prevOutput;

    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = alpha * (prevOutput + x - prevInput);
      out[i] = y;
      prevInput = x;
      prevOutput = y;
    }

    this.prevInput = prevInput;
    this.prevOutput = prevOutput;
    return out;
  }

  /** フィルタ状態(前回入出力値)をクリアする。 */
  reset(): void {
    this.prevInput = 0;
    this.prevOutput = 0;
  }
}
