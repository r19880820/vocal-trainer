import { describe, expect, it } from 'vitest';
import { analyzeVocalRange } from './analyzeRange';
import { RANGE_BIN_MIN_MS, RANGE_MIN_BINS } from '../constants';
import type { ProcessedPitchSample, RawPitchSample } from '../types';

const HOP_MS = 12;
// RANGE_BIN_MIN_MS(250ms)を確実に超える1ビンあたりのサンプル数
const SAMPLES_PER_BIN = Math.ceil(RANGE_BIN_MIN_MS / HOP_MS) + 10;

interface BinSpec {
  midi: number; // ビン中心(整数)
  confidence: number;
  /** 連続サンプル間の|Δcent|(交互に +jitterCents/2 と -jitterCents/2 で振らせて中央値=jitterCentsにする) */
  jitterCents: number;
  count?: number; // 既定 SAMPLES_PER_BIN
}

/**
 * 半音ビンごとに一定confidence・一定ジッターの合成サンプル列を作る。
 * timestampMsはHOP_MS刻みで単調増加(録音1本分の想定。パス連結時の挙動は別テストで確認)。
 */
function buildSamples(specs: BinSpec[]): { raw: RawPitchSample[]; processed: ProcessedPitchSample[] } {
  const raw: RawPitchSample[] = [];
  const processed: ProcessedPitchSample[] = [];
  let idx = 0;
  let t = 0;
  for (const spec of specs) {
    const count = spec.count ?? SAMPLES_PER_BIN;
    for (let i = 0; i < count; i++) {
      // 交互に ±jitterCents/2 だけ振って、隣接差の中央値が jitterCents になるようにする
      const offsetCents = i % 2 === 0 ? spec.jitterCents / 2 : -spec.jitterCents / 2;
      const midiNote = spec.midi + offsetCents / 100;
      raw.push({
        sampleIndex: idx,
        timestampMs: t,
        frequencyHz: 220,
        belowThreshold: true,
        confidence: spec.confidence,
        amplitude: 0.05,
      });
      processed.push({
        sampleIndex: idx,
        timestampMs: t,
        frequencyHzForScoring: 220,
        frequencyHzForDisplay: 220,
        midiNote,
        voicing: 'voiced',
      });
      idx += 1;
      t += HOP_MS;
    }
  }
  return { raw, processed };
}

describe('analyzeVocalRange', () => {
  it('(a) 中央が安定・両端でconfidence低下+ジッター増加 → comfortが内側に縮む', () => {
    // 55..63の9半音。中央(57-61)は高confidence・低ジッター、両端(55,56,62,63)は低confidence・高ジッター。
    const { raw, processed } = buildSamples([
      { midi: 55, confidence: 0.75, jitterCents: 6 },
      { midi: 56, confidence: 0.75, jitterCents: 6 },
      { midi: 57, confidence: 0.9, jitterCents: 0 },
      { midi: 58, confidence: 0.9, jitterCents: 0 },
      { midi: 59, confidence: 0.9, jitterCents: 0 },
      { midi: 60, confidence: 0.9, jitterCents: 0 },
      { midi: 61, confidence: 0.9, jitterCents: 0 },
      { midi: 62, confidence: 0.75, jitterCents: 6 },
      { midi: 63, confidence: 0.75, jitterCents: 6 },
    ]);

    const result = analyzeVocalRange(raw, processed);

    expect(result.ok).toBe(true);
    expect(result.fullLowMidi).toBe(55);
    expect(result.fullHighMidi).toBe(63);
    // 基準confidence=0.9、RANGE_CONF_DROP=0.08 → 閾値0.82。端の0.75は閾値未満で除外される。
    expect(result.comfortLowMidi).toBe(57);
    expect(result.comfortHighMidi).toBe(61);
  });

  it('(b) 全体が均質に安定 → comfort範囲はfull範囲と一致する', () => {
    const midis = [55, 56, 57, 58, 59, 60, 61, 62, 63];
    const { raw, processed } = buildSamples(midis.map((midi) => ({ midi, confidence: 0.85, jitterCents: 4 })));

    const result = analyzeVocalRange(raw, processed);

    expect(result.ok).toBe(true);
    expect(result.fullLowMidi).toBe(55);
    expect(result.fullHighMidi).toBe(63);
    expect(result.comfortLowMidi).toBe(55);
    expect(result.comfortHighMidi).toBe(63);
  });

  it('(c) 出せたビンがRANGE_MIN_BINS未満 → ok=falseで全フィールドnull', () => {
    expect(RANGE_MIN_BINS).toBeGreaterThanOrEqual(3);
    // 2ビンのみ、それぞれ十分な有声時間
    const { raw, processed } = buildSamples([
      { midi: 60, confidence: 0.9, jitterCents: 0 },
      { midi: 62, confidence: 0.9, jitterCents: 0 },
    ]);

    const result = analyzeVocalRange(raw, processed);

    expect(result.ok).toBe(false);
    expect(result.fullLowMidi).toBeNull();
    expect(result.fullHighMidi).toBeNull();
    expect(result.comfortLowMidi).toBeNull();
    expect(result.comfortHighMidi).toBeNull();
  });

  it('(d) confidenceは一定でジッターのみ端で悪化 → その端はcomfortから除外される', () => {
    // 55..63。confidenceは全ビン0.9で一定(低下なし)。中央(57-61)はジッター5cent、
    // 端(55,56,62,63)はジッター20cent(基準5×RANGE_JITTER_FACTOR(1.8)=9を超える)。
    const { raw, processed } = buildSamples([
      { midi: 55, confidence: 0.9, jitterCents: 20 },
      { midi: 56, confidence: 0.9, jitterCents: 20 },
      { midi: 57, confidence: 0.9, jitterCents: 5 },
      { midi: 58, confidence: 0.9, jitterCents: 5 },
      { midi: 59, confidence: 0.9, jitterCents: 5 },
      { midi: 60, confidence: 0.9, jitterCents: 5 },
      { midi: 61, confidence: 0.9, jitterCents: 5 },
      { midi: 62, confidence: 0.9, jitterCents: 20 },
      { midi: 63, confidence: 0.9, jitterCents: 20 },
    ]);

    const result = analyzeVocalRange(raw, processed);

    expect(result.ok).toBe(true);
    expect(result.fullLowMidi).toBe(55);
    expect(result.fullHighMidi).toBe(63);
    expect(result.comfortLowMidi).toBe(57);
    expect(result.comfortHighMidi).toBe(61);
  });

  it('有声時間がRANGE_BIN_MIN_MS未満のビンは「出せた」に数えない', () => {
    const midis = [55, 56, 57, 58, 59, 60, 61, 62, 63];
    const { raw, processed } = buildSamples(midis.map((midi) => ({ midi, confidence: 0.85, jitterCents: 0 })));
    // 最高ビン(63)だけサンプル数を減らして有声時間をRANGE_BIN_MIN_MS未満にする
    const shortCount = Math.floor(RANGE_BIN_MIN_MS / HOP_MS / 2);
    const { raw: rawShort, processed: processedShort } = buildSamples([
      ...midis.slice(0, -1).map((midi) => ({ midi, confidence: 0.85, jitterCents: 0 })),
      { midi: 63, confidence: 0.85, jitterCents: 0, count: shortCount },
    ]);

    const full = analyzeVocalRange(raw, processed);
    const short = analyzeVocalRange(rawShort, processedShort);

    expect(full.fullHighMidi).toBe(63);
    expect(short.fullHighMidi).toBe(62); // 63は有声時間不足で「出せたビン」から除外される
  });

  it('raw/processedが空なら ok=false', () => {
    const result = analyzeVocalRange([], []);
    expect(result.ok).toBe(false);
    expect(result.fullLowMidi).toBeNull();
  });

  it('voicedでないサンプル(silent等)はビン集計に含めない', () => {
    const { raw, processed } = buildSamples([
      { midi: 60, confidence: 0.9, jitterCents: 0 },
      { midi: 61, confidence: 0.9, jitterCents: 0 },
      { midi: 62, confidence: 0.9, jitterCents: 0 },
    ]);
    // 大量のsilentサンプルを別の(本来なら達成されるはずの)ビンとして混入させる
    let t = processed[processed.length - 1].timestampMs + HOP_MS;
    for (let i = 0; i < SAMPLES_PER_BIN; i++) {
      raw.push({
        sampleIndex: 1000 + i,
        timestampMs: t,
        frequencyHz: 0,
        belowThreshold: false,
        confidence: 0,
        amplitude: 0.0001,
      });
      processed.push({
        sampleIndex: 1000 + i,
        timestampMs: t,
        frequencyHzForScoring: 0,
        frequencyHzForDisplay: 0,
        midiNote: 70,
        voicing: 'silent',
      });
      t += HOP_MS;
    }

    const result = analyzeVocalRange(raw, processed);
    expect(result.ok).toBe(true);
    expect(result.fullHighMidi).toBe(62); // 70(silent)はビンとして数えられない
  });
});
