import { describe, expect, it } from 'vitest';
import { YinDetector } from './yin';
import { centsBetween } from './conversions';
import { F0_MAX_HZ, F0_MIN_HZ } from '../constants';

// ---------------------------------------------------------------------------
// 決定論的 PRNG(mulberry32)。シード固定でノイズ混入テストを再現可能にする。
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u1 = rand();
    while (u1 <= Number.EPSILON) u1 = rand();
    const u2 = rand();
    const mag = Math.sqrt(-2 * Math.log(u1));
    spare = mag * Math.sin(2 * Math.PI * u2);
    return mag * Math.cos(2 * Math.PI * u2);
  };
}

type SignalType = 'sine' | 'harmonic' | 'noisy';
const SIGNAL_TYPES: SignalType[] = ['sine', 'harmonic', 'noisy'];

/** 合成波形を生成する。noisy は SNR 20dB のホワイトガウスノイズ混入(シード固定)。 */
function generateSignal(
  type: SignalType,
  freqHz: number,
  fs: number,
  durationS: number,
  seed: number
): Float32Array {
  const n = Math.round(fs * durationS);
  const out = new Float32Array(n);

  if (type === 'sine') {
    for (let i = 0; i < n; i++) {
      out[i] = Math.sin((2 * Math.PI * freqHz * i) / fs);
    }
  } else if (type === 'harmonic') {
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      out[i] =
        1.0 * Math.sin(2 * Math.PI * freqHz * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * freqHz * t) +
        0.3 * Math.sin(2 * Math.PI * 3 * freqHz * t);
    }
  } else {
    const rand = mulberry32(seed);
    const gauss = makeGaussian(rand);
    const signalPower = 0.5; // 振幅1の正弦波の平均電力
    const snrLinear = Math.pow(10, 20 / 10); // SNR 20dB
    const noiseStd = Math.sqrt(signalPower / snrLinear);
    for (let i = 0; i < n; i++) {
      out[i] = Math.sin((2 * Math.PI * freqHz * i) / fs) + noiseStd * gauss();
    }
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function logSpace(startHz: number, endHz: number, count: number): number[] {
  const logStart = Math.log(startHz);
  const logEnd = Math.log(endHz);
  const freqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    freqs.push(Math.exp(logStart + t * (logEnd - logStart)));
  }
  return freqs;
}

interface SweepResult {
  type: SignalType;
  freqHz: number;
  fs: number;
  medianDetectedHz: number;
  biasCents: number;
  sampleCount: number;
}

const STEADY_START_MS = 300; // 先頭0.3秒を除外
const HOP_SIZE = 256;

function runSweepPoint(
  type: SignalType,
  freqHz: number,
  fs: number,
  durationS: number,
  seed: number
): SweepResult {
  const signal = generateSignal(type, freqHz, fs, durationS, seed);
  const detector = new YinDetector(fs);

  const detectedHz: number[] = [];
  for (let i = 0; i < signal.length; i += HOP_SIZE) {
    const hop = signal.subarray(i, Math.min(i + HOP_SIZE, signal.length));
    if (hop.length === 0) continue;
    const sample = detector.push(hop);
    if (sample && sample.timestampMs >= STEADY_START_MS && sample.frequencyHz > 0) {
      detectedHz.push(sample.frequencyHz);
    }
  }

  const medianDetectedHz = median(detectedHz);
  const biasCents = centsBetween(medianDetectedHz, freqHz);
  return { type, freqHz, fs, medianDetectedHz, biasCents, sampleCount: detectedHz.length };
}

function seedFor(type: SignalType, freqHz: number, salt: number): number {
  const typeIndex = SIGNAL_TYPES.indexOf(type);
  return Math.round(freqHz * 1000) + typeIndex * 7919 + salt;
}

// ---------------------------------------------------------------------------
// F0スイープ(受入条件の核心): F0_MIN_HZ〜F0_MAX_HZ(定数参照。レビューC-1で60Hzに拡張済み)を
// 対数間隔で30点以上、fs=24000。
// ---------------------------------------------------------------------------
const MAIN_FS = 24000;
const SWEEP_DURATION_S = 2.0;
const SWEEP_FREQS = logSpace(F0_MIN_HZ, F0_MAX_HZ, 30);

const mainSweepResults: SweepResult[] = [];
for (const type of SIGNAL_TYPES) {
  for (const freqHz of SWEEP_FREQS) {
    mainSweepResults.push(
      runSweepPoint(type, freqHz, MAIN_FS, SWEEP_DURATION_S, seedFor(type, freqHz, 1))
    );
  }
}

describe(`YIN F0 sweep ${F0_MIN_HZ}-${F0_MAX_HZ}Hz @ fs=${MAIN_FS} (sine/harmonic/noisy, N=${SWEEP_FREQS.length}/type)`, () => {
  it.each(mainSweepResults)(
    '$type @ $freqHz Hz -> median=$medianDetectedHz Hz bias=$biasCents cent (target <=10cent)',
    (r) => {
      expect(
        Math.abs(r.biasCents),
        `type=${r.type} freq=${r.freqHz.toFixed(3)}Hz median=${r.medianDetectedHz.toFixed(3)}Hz ` +
          `bias=${r.biasCents.toFixed(3)}cent n=${r.sampleCount}`
      ).toBeLessThanOrEqual(10);
    }
  );

  it('reports the maximum |bias| across the whole sweep', () => {
    const worst = mainSweepResults.reduce((a, b) => (Math.abs(a.biasCents) > Math.abs(b.biasCents) ? a : b));
    // eslint-disable-next-line no-console
    console.log(
      `[YIN sweep @ ${MAIN_FS}Hz] max |bias| = ${Math.abs(worst.biasCents).toFixed(3)}cent ` +
        `at type=${worst.type} freq=${worst.freqHz.toFixed(2)}Hz`
    );
    expect(
      Math.abs(worst.biasCents),
      `max bias = ${Math.abs(worst.biasCents).toFixed(3)}cent at type=${worst.type} freq=${worst.freqHz.toFixed(2)}Hz`
    ).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// fs=22050 でも代表3点(110/440/660Hz)で±10cent確認。
// ---------------------------------------------------------------------------
const SECONDARY_FS = 22050;
const SECONDARY_FREQS = [110, 440, 660];

const secondaryResults: SweepResult[] = [];
for (const type of SIGNAL_TYPES) {
  for (const freqHz of SECONDARY_FREQS) {
    secondaryResults.push(
      runSweepPoint(type, freqHz, SECONDARY_FS, SWEEP_DURATION_S, seedFor(type, freqHz, 2))
    );
  }
}

describe(`YIN representative points @ fs=${SECONDARY_FS} (110/440/660Hz, sine/harmonic/noisy)`, () => {
  it.each(secondaryResults)(
    '$type @ $freqHz Hz -> median=$medianDetectedHz Hz bias=$biasCents cent (target <=10cent)',
    (r) => {
      expect(
        Math.abs(r.biasCents),
        `type=${r.type} freq=${r.freqHz.toFixed(3)}Hz median=${r.medianDetectedHz.toFixed(3)}Hz ` +
          `bias=${r.biasCents.toFixed(3)}cent n=${r.sampleCount}`
      ).toBeLessThanOrEqual(10);
    }
  );
});

// ---------------------------------------------------------------------------
// 境界条件
// ---------------------------------------------------------------------------
describe('YinDetector boundary conditions', () => {
  it('throws when W >= 2*tauMax is violated (fail-loud contract)', () => {
    // fs=48000 -> tauMax = floor(48000/F0_MIN_HZ) = floor(48000/60) = 800, 2*800=1600 > YIN_WINDOW(1024)
    expect(() => new YinDetector(48000)).toThrow(/tauMax/);
  });

  it('does not throw for supported internal rates (24000 / 22050)', () => {
    expect(() => new YinDetector(24000)).not.toThrow();
    expect(() => new YinDetector(22050)).not.toThrow();
  });

  it('silence (all-zero input) yields frequencyHz=0 / belowThreshold=false / amplitude=0', () => {
    const detector = new YinDetector(24000);
    const hop = new Float32Array(HOP_SIZE); // all zero
    let lastSample: ReturnType<typeof detector.push> = null;
    for (let i = 0; i < 20; i++) {
      const s = detector.push(hop);
      if (s) lastSample = s;
    }
    expect(lastSample).not.toBeNull();
    expect(lastSample!.frequencyHz).toBe(0);
    expect(lastSample!.belowThreshold).toBe(false);
    expect(lastSample!.amplitude).toBe(0);
    expect(lastSample!.confidence).toBe(0);
  });

  it('white-noise-only input never crosses the absolute threshold (belowThreshold=false for all samples)', () => {
    const fs = 24000;
    const detector = new YinDetector(fs);
    const rand = mulberry32(999);
    const durationS = 1.5;
    const n = Math.round(fs * durationS);
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1; // uniform white noise in [-1, 1]

    let sampleCount = 0;
    for (let i = 0; i < noise.length; i += HOP_SIZE) {
      const hop = noise.subarray(i, Math.min(i + HOP_SIZE, noise.length));
      if (hop.length === 0) continue;
      const sample = detector.push(hop);
      if (sample) {
        sampleCount++;
        expect(
          sample.belowThreshold,
          `unexpected belowThreshold=true at t=${sample.timestampMs.toFixed(1)}ms (white noise)`
        ).toBe(false);
      }
    }
    expect(sampleCount).toBeGreaterThan(0);
  });

  it('returns null until the internal buffer (N = W + tauMax) is filled, then returns samples', () => {
    const fs = 24000;
    const detector = new YinDetector(fs);
    // N = 1024 + 300 = 1324 samples. hop=256 => 5 hops (1280) still short, 6th hop fills it.
    const hop = new Float32Array(HOP_SIZE).fill(0.001);
    const results: Array<ReturnType<typeof detector.push>> = [];
    for (let i = 0; i < 6; i++) {
      results.push(detector.push(hop));
    }
    expect(results.slice(0, 5).every((r) => r === null)).toBe(true);
    expect(results[5]).not.toBeNull();
  });

  it('flush() always returns an empty array (YIN has no delayed output)', () => {
    const detector = new YinDetector(24000);
    expect(detector.flush()).toEqual([]);
    const hop = new Float32Array(HOP_SIZE).fill(0.01);
    for (let i = 0; i < 10; i++) detector.push(hop);
    expect(detector.flush()).toEqual([]);
  });

  it('reset() clears buffered state so behavior matches a freshly constructed detector', () => {
    const fs = 24000;
    const detector = new YinDetector(fs);
    const signal = generateSignal('sine', 220, fs, 0.5, seedFor('sine', 220, 3));

    const collect = (det: YinDetector): number[] => {
      const out: number[] = [];
      for (let i = 0; i < signal.length; i += HOP_SIZE) {
        const hop = signal.subarray(i, Math.min(i + HOP_SIZE, signal.length));
        if (hop.length === 0) continue;
        const s = det.push(hop);
        if (s) out.push(s.frequencyHz);
      }
      return out;
    };

    const first = collect(detector);
    detector.reset();
    const second = collect(detector);

    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBeCloseTo(first[i], 6);
    }
  });
});

// ---------------------------------------------------------------------------
// レビューC-1: F0_MIN_HZ=60 への拡張回帰テスト。
// ---------------------------------------------------------------------------
describe('YinDetector C-1: F0_MIN_HZ=60 lower-bound regression', () => {
  it(
    '65.4Hz(C2、8倍音の声門波近似)@24kHz が ±10cent以内で65.4Hz付近と検出される ' +
      '(旧F0_MIN=80Hzでは探索上限に張り付き80Hzと誤報告されていたケース)',
    () => {
      const fs = 24000;
      const freqHz = 65.4; // C2
      const durationS = 2.0;
      const n = Math.round(fs * durationS);
      const signal = new Float32Array(n);
      // 声門波(グロタル波)の粗い近似: 基音+第2〜8倍音を 1/k 減衰で重畳(鋸歯状に近い波形)。
      for (let i = 0; i < n; i++) {
        const t = i / fs;
        let v = 0;
        for (let k = 1; k <= 8; k++) {
          v += (1 / k) * Math.sin(2 * Math.PI * k * freqHz * t);
        }
        signal[i] = v;
      }

      const detector = new YinDetector(fs);
      const detectedHz: number[] = [];
      for (let i = 0; i < signal.length; i += HOP_SIZE) {
        const hop = signal.subarray(i, Math.min(i + HOP_SIZE, signal.length));
        if (hop.length === 0) continue;
        const sample = detector.push(hop);
        if (sample && sample.timestampMs >= STEADY_START_MS && sample.frequencyHz > 0) {
          detectedHz.push(sample.frequencyHz);
        }
      }

      expect(detectedHz.length).toBeGreaterThan(0);
      const med = median(detectedHz);
      const biasCents = centsBetween(med, freqHz);
      expect(
        Math.abs(biasCents),
        `median=${med.toFixed(3)}Hz bias=${biasCents.toFixed(3)}cent n=${detectedHz.length}`
      ).toBeLessThanOrEqual(10);
    }
  );

  it('50Hz(探索下限60Hz未満)の純音では belowThreshold=false のままになる(fail-loud)', () => {
    const fs = 24000;
    const freqHz = 50;
    const durationS = 1.5;
    const signal = generateSignal('sine', freqHz, fs, durationS, seedFor('sine', freqHz, 4));

    const detector = new YinDetector(fs);
    let sampleCount = 0;
    for (let i = 0; i < signal.length; i += HOP_SIZE) {
      const hop = signal.subarray(i, Math.min(i + HOP_SIZE, signal.length));
      if (hop.length === 0) continue;
      const sample = detector.push(hop);
      if (sample && sample.timestampMs >= STEADY_START_MS) {
        sampleCount++;
        expect(
          sample.belowThreshold,
          `unexpected belowThreshold=true at t=${sample.timestampMs.toFixed(1)}ms (50Hz < F0_MIN_HZ=${F0_MIN_HZ})`
        ).toBe(false);
      }
    }
    expect(sampleCount).toBeGreaterThan(0);
  });
});
