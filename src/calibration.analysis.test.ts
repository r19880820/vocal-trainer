// 較正解析ハーネス: recordings/ のユーザー録音WAVを実パイプラインに通し統計を
// recordings/calibration_report.json へ出力する(AUDIO_ANALYSIS.md「較正記録」の生成元)。
// recordings/ が無い環境(CI等)では自動スキップ。
// 実行: npx vitest run src/calibration.analysis.test.ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { runPipelineOffline } from './core/offline';
import { hzToMidi, midiToNoteName } from './core/pitch/conversions';

const DIR = 'recordings';

function decodeWav(buf: Buffer): { sampleRate: number; pcm: Float32Array } {
  const sampleRate = buf.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { sampleRate, pcm };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function db(a: number): number {
  return a > 0 ? 20 * Math.log10(a) : -120;
}

describe.skipIf(!existsSync(DIR))('calibration analysis', () => {
  it('analyzes user recordings', () => {
    const report: unknown[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.wav'))) {
      const { sampleRate, pcm } = decodeWav(readFileSync(join(DIR, file)));
      const { raw, processed } = runPipelineOffline(pcm, sampleRate);

      const durS = pcm.length / sampleRate;
      const counts: Record<string, number> = { voiced: 0, silent: 0, tooQuiet: 0, unclear: 0 };
      for (const p of processed) counts[p.voicing] += 1;
      const total = processed.length || 1;

      // 先頭500msのRMS(ノイズフロア推定窓)と、有声区間のRMS
      const first500 = raw.filter((r) => r.timestampMs <= 500).map((r) => db(r.amplitude));
      const voicedIdx = processed.map((p, i) => ({ p, i })).filter((x) => x.p.voicing === 'voiced');
      const voicedDb = voicedIdx.map((x) => db(raw[x.i]?.amplitude ?? 0));
      const voicedConf = voicedIdx.map((x) => raw[x.i]?.confidence ?? 0);

      const voicedHz = voicedIdx.map((x) => x.p.frequencyHzForScoring).filter((h) => h > 0);
      const medHz = median(voicedHz);
      const medMidi = hzToMidi(medHz);
      // 自分の中央値に対する cents 分布(=「本人がまっすぐ伸ばしたつもり」のばらつき)
      const cents = voicedHz.map((h) => 1200 * Math.log2(h / medHz));
      const absCents = cents.map(Math.abs);
      // 安定区間(有声開始500ms以降)のσ
      const firstVoicedMs = voicedIdx[0]?.p.timestampMs ?? 0;
      const stable = voicedIdx.filter((x) => x.p.timestampMs >= firstVoicedMs + 500);
      const stableCents = stable
        .map((x) => x.p.frequencyHzForScoring)
        .filter((h) => h > 0)
        .map((h) => 1200 * Math.log2(h / medHz));
      const meanSt = stableCents.reduce((s, v) => s + v, 0) / (stableCents.length || 1);
      const sigma = Math.sqrt(
        stableCents.reduce((s, v) => s + (v - meanSt) ** 2, 0) / (stableCents.length || 1),
      );

      report.push(
          {
            file,
            sampleRate,
            durS: +durS.toFixed(2),
            voicingPct: {
              voiced: +((100 * counts.voiced) / total).toFixed(1),
              silent: +((100 * counts.silent) / total).toFixed(1),
              tooQuiet: +((100 * counts.tooQuiet) / total).toFixed(1),
              unclear: +((100 * counts.unclear) / total).toFixed(1),
            },
            noiseWin500msDb: { med: +median(first500).toFixed(1), p90: +pct(first500, 90).toFixed(1) },
            voicedDb: { med: +median(voicedDb).toFixed(1), p10: +pct(voicedDb, 10).toFixed(1) },
            confMed: +median(voicedConf).toFixed(2),
            pitch: {
              medHz: +medHz.toFixed(1),
              note: midiToNoteName(Math.round(medMidi)),
              centsVsNote: +((medMidi - Math.round(medMidi)) * 100).toFixed(0),
            },
            spreadVsOwnMedian: {
              medAbsCents: +median(absCents).toFixed(1),
              p90AbsCents: +pct(absCents, 90).toFixed(1),
              within50c: +((100 * absCents.filter((c) => c <= 50).length) / (absCents.length || 1)).toFixed(1),
              within100c: +((100 * absCents.filter((c) => c <= 100).length) / (absCents.length || 1)).toFixed(1),
            },
            stableSigmaCents: +sigma.toFixed(1),
            stableSamples: stableCents.length,
          },
      );
    }
    writeFileSync(join(DIR, 'calibration_report.json'), JSON.stringify(report, null, 2));
  });
});
