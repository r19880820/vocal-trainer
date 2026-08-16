import { describe, expect, it } from 'vitest';
import { PitchProcessor } from './processor';
import { hzToMidi } from '../pitch/conversions';
import type { RawPitchSample } from '../types';

const FS = 24000;
const HOP_MS = 10;

function dbToAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

/** voiced想定のRawPitchSampleを作る(amplitudeは-20dBFS相当=十分大きい)。 */
function makeVoiced(frequencyHz: number, i: number, timestampMs = i * HOP_MS): RawPitchSample {
  return {
    sampleIndex: i,
    timestampMs,
    frequencyHz,
    belowThreshold: true,
    confidence: 0.9,
    amplitude: dbToAmplitude(-20),
  };
}

function makeRaw(overrides: {
  amplitudeDb: number;
  belowThreshold: boolean;
  frequencyHz: number;
  i: number;
}): RawPitchSample {
  return {
    sampleIndex: overrides.i,
    timestampMs: overrides.i * HOP_MS,
    frequencyHz: overrides.frequencyHz,
    belowThreshold: overrides.belowThreshold,
    confidence: 0.9,
    amplitude: dbToAmplitude(overrides.amplitudeDb),
  };
}

describe('PitchProcessor voicing classification', () => {
  // GATE_FLOOR_DBFS は 2026-08-16 のiPhone実録較正で -55 → -62 に更新(silent閾値は -10 して -72)
  describe('noiseFloor未設定(gateDb=GATE_FLOOR_DBFS=-62, silent閾値=-72)', () => {
    it('classifies rmsDb well below -72dBFS as silent', () => {
      const p = new PitchProcessor(FS);
      const out = p.process(makeRaw({ amplitudeDb: -80, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('silent');
    });

    it('classifies rmsDb between -72 and -62dBFS as tooQuiet', () => {
      const p = new PitchProcessor(FS);
      const out = p.process(makeRaw({ amplitudeDb: -66, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('tooQuiet');
    });

    it('classifies loud-enough + belowThreshold=false as unclear', () => {
      const p = new PitchProcessor(FS);
      const out = p.process(makeRaw({ amplitudeDb: -20, belowThreshold: false, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('unclear');
    });

    it('classifies loud-enough + belowThreshold=true + frequencyHz>0 as voiced', () => {
      const p = new PitchProcessor(FS);
      const out = p.process(makeRaw({ amplitudeDb: -20, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('voiced');
    });

    it('treats amplitude=0 (rmsDb=-Infinity) as silent', () => {
      const p = new PitchProcessor(FS);
      const out = p.process({
        sampleIndex: 0,
        timestampMs: 0,
        frequencyHz: 200,
        belowThreshold: true,
        confidence: 0.9,
        amplitude: 0,
      });
      expect(out.voicing).toBe('silent');
    });
  });

  describe('noiseFloor設定あり(-40dBFS: gateDb=max(-28,-55)=-28, silent閾値=-37)', () => {
    it('classifies rmsDb below -37dBFS as silent', () => {
      const p = new PitchProcessor(FS);
      p.setNoiseFloorDb(-40);
      const out = p.process(makeRaw({ amplitudeDb: -45, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('silent');
    });

    it('classifies rmsDb between -37 and -28dBFS as tooQuiet', () => {
      const p = new PitchProcessor(FS);
      p.setNoiseFloorDb(-40);
      const out = p.process(makeRaw({ amplitudeDb: -32, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('tooQuiet');
    });

    it('classifies loud-enough + belowThreshold=false as unclear', () => {
      const p = new PitchProcessor(FS);
      p.setNoiseFloorDb(-40);
      const out = p.process(makeRaw({ amplitudeDb: -20, belowThreshold: false, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('unclear');
    });

    it('classifies loud-enough + belowThreshold=true + frequencyHz>0 as voiced', () => {
      const p = new PitchProcessor(FS);
      p.setNoiseFloorDb(-40);
      const out = p.process(makeRaw({ amplitudeDb: -20, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('voiced');
    });

    it('a noisier environment raises the gate above the absolute floor', () => {
      const p = new PitchProcessor(FS);
      p.setNoiseFloorDb(-40); // gateDb=-28 (higher than GATE_FLOOR_DBFS=-55)
      // -30dBFS would be "voiced" with no noise floor set (>= -55), but here it's still tooQuiet (< -28).
      const out = p.process(makeRaw({ amplitudeDb: -30, belowThreshold: true, frequencyHz: 200, i: 0 }));
      expect(out.voicing).toBe('tooQuiet');
    });
  });

  it('defensively falls back to unclear when belowThreshold=true but frequencyHz<=0', () => {
    const p = new PitchProcessor(FS);
    const out = p.process(makeRaw({ amplitudeDb: -20, belowThreshold: true, frequencyHz: 0, i: 0 }));
    expect(out.voicing).toBe('unclear');
  });
});

describe('PitchProcessor octave fix', () => {
  // 検証方法: 実装から独立して手計算した期待値ではなく、①アルゴリズムをステップ単位で
  // 追跡し、②「補正されない場合(バグ)」との差が数値として現れる区間で厳密一致を検証する。
  // 具体的には: 単発/2連続の跳躍は必ず200Hz付近に収まり300や400には決して触れないこと、
  // 持続的な跳躍は複数サンプル後に確実に400Hzへ収束することを固定する。

  it('(a) a single 2x-jump sample is corrected back toward the recent anchor', () => {
    const p = new PitchProcessor(FS);
    const s0 = p.process(makeVoiced(200, 0));
    const s1 = p.process(makeVoiced(400, 1)); // 単発オクターブ跳躍
    const s2 = p.process(makeVoiced(200, 2));

    expect(s0.frequencyHzForScoring).toBeCloseTo(200, 5);
    // 補正が効いていなければ median([200,400])=300 になるはずだが、200に留まる。
    expect(s1.frequencyHzForScoring).toBeCloseTo(200, 5);
    expect(s2.frequencyHzForScoring).toBeCloseTo(200, 5);
  });

  it('(a) two consecutive 2x-jump samples are both corrected back', () => {
    const p = new PitchProcessor(FS);
    p.process(makeVoiced(200, 0));
    const s1 = p.process(makeVoiced(400, 1)); // streak=1
    const s2 = p.process(makeVoiced(400, 2)); // streak=2(まだ補正)
    const s3 = p.process(makeVoiced(200, 3)); // 通常に復帰

    expect(s1.frequencyHzForScoring).toBeCloseTo(200, 5);
    expect(s2.frequencyHzForScoring).toBeCloseTo(200, 5);
    expect(s3.frequencyHzForScoring).toBeCloseTo(200, 5);
  });

  it('(a) a single 0.5x-jump (down an octave) is corrected back up', () => {
    const p = new PitchProcessor(FS);
    p.process(makeVoiced(400, 0));
    const s1 = p.process(makeVoiced(200, 1)); // 400のアンカーに対して単発の半分跳躍
    expect(s1.frequencyHzForScoring).toBeCloseTo(400, 5);
  });

  it('(b) a persistent 2x-jump (5+ samples) is treated as genuine and passes through by the 3rd sample', () => {
    const p = new PitchProcessor(FS);
    const freqs = [200, 200, 200, 400, 400, 400, 400, 400, 400, 400];
    const scoring = freqs.map((f, i) => p.process(makeVoiced(f, i)).frequencyHzForScoring);

    // median窓(5点)のラグにより、octave-fix自体は3サンプル目(index5)で切り替わるが、
    // 出力(median後)が400へ収束するのは窓の過半数が新しい値になった時点(index7)から。
    // 「補正され続けるバグ」なら以降ずっと200のまま、「一度も補正しないバグ」ならもっと早く
    // (index5)400化する — どちらも本テストで検出できる。
    expect(scoring.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(scoring[5]).toBeCloseTo(200, 5);
    expect(scoring[6]).toBeCloseTo(200, 5);
    expect(scoring[7]).toBeCloseTo(400, 5);
    expect(scoring[8]).toBeCloseTo(400, 5);
    expect(scoring[9]).toBeCloseTo(400, 5);
  });

  it('(b) after switching to the new anchor, a subsequent return to the old band is itself treated as a jump', () => {
    const p = new PitchProcessor(FS);
    const freqs = [200, 200, 200, 400, 400, 400, 400, 400, 400, 400, 400, 400];
    freqs.forEach((f, i) => p.process(makeVoiced(f, i)));
    // ここまでで anchor は 400 に切り替わっている(上のテストで確認済み)。
    // 単発で200へ戻ると、新アンカー(400)から見て単発跳躍として補正され、400近傍に留まる。
    const back = p.process(makeVoiced(200, freqs.length));
    expect(back.frequencyHzForScoring).toBeGreaterThan(300); // 200まで落ちない(=補正が効いている)
  });

  it('(c) anchor pollution resistance: a lone bad seed self-heals within a few samples and stays stable', () => {
    const p = new PitchProcessor(FS);
    const freqs = [400, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200];
    const scoring = freqs.map((f, i) => p.process(makeVoiced(f, i)).frequencyHzForScoring);

    // 最初の1サンプルは比較対象(アンカー)が無いため誤検出のシード400をそのまま採用せざるを得ない。
    expect(scoring[0]).toBeCloseTo(400, 5);
    // median窓のラグで数サンプルは400寄りに残るが、真の多数派(200)に収束する。
    expect(scoring[5]).toBeCloseTo(200, 5);
    expect(scoring[6]).toBeCloseTo(200, 5);
    // 収束後は安定して200を保ち続ける(汚染が恒久化しない)。
    for (let i = 5; i < scoring.length; i++) {
      expect(scoring[i]).toBeCloseTo(200, 5);
    }
  });

  it('a large non-octave jump (e.g. ~2.2x) is left to the median filter, not treated as an octave error', () => {
    const p = new PitchProcessor(FS);
    p.process(makeVoiced(200, 0));
    p.process(makeVoiced(205, 1));
    p.process(makeVoiced(195, 2));
    const out = p.process(makeVoiced(900, 3)); // 2.17x ≈ 2604cent: ±100cent近傍の2倍/半分ではない
    // 900自体はoctave-fixで補正されず素通しでmedian窓に入るが、median([200,205,195,900])=202.5
    // (900は外れ値として中央値には現れない)。
    expect(out.frequencyHzForScoring).toBeCloseTo(202.5, 5);
    expect(out.frequencyHzForScoring).not.toBeGreaterThan(300);
  });
});

describe('PitchProcessor median filter', () => {
  it('removes a single outlier frequency from the scoring output', () => {
    const p = new PitchProcessor(FS);
    const freqs = [200, 205, 195, 900, 198, 202, 199, 201];
    const scoring = freqs.map((f, i) => p.process(makeVoiced(f, i)).frequencyHzForScoring);

    // 900の外れ値が現れる直後も、直近5点の中央値には900は含まれない。
    for (const s of scoring) {
      expect(s).toBeLessThan(300);
      expect(s).toBeGreaterThan(150);
    }
  });

  it('does not update the scoring window for non-voiced samples (they are excluded, not zero-filled)', () => {
    const p = new PitchProcessor(FS);
    p.process(makeVoiced(200, 0));
    p.process(makeVoiced(205, 1));
    // tooQuiet(voicedではない)を挟む。voiced扱いなら周波数0がmedianを壊すはずだが除外されるため崩れない。
    const quiet = p.process(makeRaw({ amplitudeDb: -66, belowThreshold: true, frequencyHz: 200, i: 2 }));
    const after = p.process(makeVoiced(195, 3));

    expect(quiet.voicing).toBe('tooQuiet');
    expect(quiet.frequencyHzForScoring).toBeCloseTo(202.5, 5); // 直近値を保持(凍結)
    expect(after.frequencyHzForScoring).toBeCloseTo(200, 5); // median([200,205,195])
  });
});

describe('PitchProcessor display EMA (cent domain)', () => {
  it('smooths frequencyHzForDisplay in the log2(hz) domain, matching an independent log2 computation', () => {
    const p = new PitchProcessor(FS);
    const freqs = [200, 205, 195, 300, 205, 195, 200];
    const outs = freqs.map((f, i) => p.process(makeVoiced(f, i)));

    // 独立にlog2ドメインEMAを、実測されたfrequencyHzForScoring列から再計算する。
    const alpha = 0.3;
    let emaLog2: number | null = null;
    let emaLinear: number | null = null;
    const log2Expected: number[] = [];
    const linearWrongExpected: number[] = [];
    for (const o of outs) {
      const x = o.frequencyHzForScoring;
      emaLog2 = emaLog2 === null ? Math.log2(x) : alpha * Math.log2(x) + (1 - alpha) * emaLog2;
      emaLinear = emaLinear === null ? x : alpha * x + (1 - alpha) * emaLinear;
      log2Expected.push(Math.pow(2, emaLog2));
      linearWrongExpected.push(emaLinear);
    }

    outs.forEach((o, i) => {
      expect(o.frequencyHzForDisplay).toBeCloseTo(log2Expected[i], 6);
    });

    // Hzドメインで平均した場合との差が終盤で明確に現れることを確認する(誤ってHzドメインで
    // 実装するとこのテストに気づかず両者が一致してしまう)。
    const lastIdx = outs.length - 1;
    expect(Math.abs(outs[lastIdx].frequencyHzForDisplay - linearWrongExpected[lastIdx])).toBeGreaterThan(0.005);
  });

  it('initializes EMA state on the first voiced sample without biasing toward 0', () => {
    const p = new PitchProcessor(FS);
    const out = p.process(makeVoiced(300, 0));
    expect(out.frequencyHzForDisplay).toBeCloseTo(300, 5);
  });

  it('holds frequencyHzForDisplay while not voiced (does not update EMA state)', () => {
    const p = new PitchProcessor(FS);
    const v1 = p.process(makeVoiced(200, 0));
    const quiet = p.process(makeRaw({ amplitudeDb: -66, belowThreshold: true, frequencyHz: 200, i: 1 }));
    expect(quiet.frequencyHzForDisplay).toBeCloseTo(v1.frequencyHzForDisplay, 6);
  });
});

describe('PitchProcessor midiNote / sampleIndex / timestampMs passthrough', () => {
  it('derives midiNote from frequencyHzForScoring via hzToMidi', () => {
    const p = new PitchProcessor(FS);
    const out = p.process(makeVoiced(440, 0));
    expect(out.midiNote).toBeCloseTo(hzToMidi(440), 6);
    expect(out.midiNote).toBeCloseTo(69, 6);
  });

  it('defaults midiNote to 0 before any voiced sample has ever been seen', () => {
    const p = new PitchProcessor(FS);
    const out = p.process(makeRaw({ amplitudeDb: -80, belowThreshold: true, frequencyHz: 200, i: 0 }));
    expect(out.voicing).toBe('silent');
    expect(out.midiNote).toBe(0);
  });

  it('carries sampleIndex and timestampMs through unchanged from the raw sample', () => {
    const p = new PitchProcessor(FS);
    const raw = makeVoiced(300, 7, 12345);
    const out = p.process(raw);
    expect(out.sampleIndex).toBe(raw.sampleIndex);
    expect(out.timestampMs).toBe(raw.timestampMs);
  });
});

describe('PitchProcessor reset', () => {
  it('clears all internal state, including a previously-set noise floor', () => {
    const p = new PitchProcessor(FS);
    p.setNoiseFloorDb(-40); // gateDb=-28 なら -30dBFS は tooQuiet のはず
    p.process(makeVoiced(200, 0));
    p.process(makeVoiced(205, 1));
    p.process(makeVoiced(195, 2));

    p.reset();

    // noiseFloorDbがクリアされていれば、-30dBFSはunset時のgate(-55)を上回るのでvoiced扱いになる。
    const afterReset = p.process(makeRaw({ amplitudeDb: -30, belowThreshold: true, frequencyHz: 200, i: 0 }));
    expect(afterReset.voicing).toBe('voiced');
  });

  it('after reset, produces the same output sequence as a fresh instance given the same inputs', () => {
    const freqs = [200, 400, 400, 400, 205, 195];

    const fresh = new PitchProcessor(FS);
    const freshOut = freqs.map((f, i) => fresh.process(makeVoiced(f, i)));

    const reused = new PitchProcessor(FS);
    reused.process(makeVoiced(999, 0));
    reused.process(makeVoiced(111, 1));
    reused.reset();
    const reusedOut = freqs.map((f, i) => reused.process(makeVoiced(f, i)));

    freshOut.forEach((o, i) => {
      expect(reusedOut[i].frequencyHzForScoring).toBeCloseTo(o.frequencyHzForScoring, 6);
      expect(reusedOut[i].frequencyHzForDisplay).toBeCloseTo(o.frequencyHzForDisplay, 6);
      expect(reusedOut[i].voicing).toBe(o.voicing);
    });
  });

  it('clears the octave-fix anchor so a post-reset sample is not compared against pre-reset history', () => {
    const p = new PitchProcessor(FS);
    p.process(makeVoiced(400, 0));
    p.process(makeVoiced(400, 1));
    p.reset();

    // リセット後、最初のサンプルは比較対象アンカーが無いのでそのまま採用される(200になり得る)。
    const out = p.process(makeVoiced(200, 0));
    expect(out.frequencyHzForScoring).toBeCloseTo(200, 5);
  });
});
