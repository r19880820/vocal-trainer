// pitch-worker: デシメート(÷2)→ hop組み立て → YIN をメインスレッド外で実行
// (ARCHITECTURE.md「データフローとスレッドモデル」)
import { HalfbandDecimator } from '../core/audio/halfband';
import { OnePoleHighpass } from '../core/audio/highpass';
import { YinDetector } from '../core/pitch/yin';
import { HPF_CUTOFF_HZ, INTERNAL_RATE_DIVISOR, YIN_HOP } from '../core/constants';

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;

let decimator: HalfbandDecimator | null = null;
let highpass: OnePoleHighpass | null = null;
let detector: YinDetector | null = null;
let pending = new Float32Array(0);

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; contextSampleRate?: number; buffer?: ArrayBuffer };
  try {
    if (msg.type === 'init') {
      const contextRate = msg.contextSampleRate;
      if (!contextRate || contextRate <= 0) {
        throw new Error(`invalid contextSampleRate: ${String(contextRate)}`);
      }
      const internalRate = contextRate / INTERNAL_RATE_DIVISOR;
      decimator = new HalfbandDecimator();
      highpass = new OnePoleHighpass(internalRate, HPF_CUTOFF_HZ); // AUDIO_ANALYSIS §3 step0
      detector = new YinDetector(internalRate);
      pending = new Float32Array(0);
      scope.postMessage({ type: 'ready', internalRate });
    } else if (msg.type === 'block' && msg.buffer && decimator && highpass && detector) {
      const block = new Float32Array(msg.buffer);
      const dec = highpass.process(decimator.process(block));
      const combined = new Float32Array(pending.length + dec.length);
      combined.set(pending);
      combined.set(dec, pending.length);
      let offset = 0;
      while (combined.length - offset >= YIN_HOP) {
        const sample = detector.push(combined.subarray(offset, offset + YIN_HOP));
        if (sample) scope.postMessage({ type: 'pitch', sample });
        offset += YIN_HOP;
      }
      pending = combined.slice(offset);
    } else if (msg.type === 'reset') {
      decimator?.reset();
      highpass?.reset();
      detector?.reset();
      pending = new Float32Array(0);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
