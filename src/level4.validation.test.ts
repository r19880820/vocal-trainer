// Level 4 実録音検証ハーネス(TRAINING_MODEL.md Level 4 v2 の実装順序②=M-3)。
// recordings/level4/ のWAV(ユーザーがチューリップ/かえるの合唱を歌ったもの)を
// 実パイプライン+evaluateLevel4 に通し、recordings/level4_report.json へ出力する。
// recordings/level4/ が無い環境(CI等)では自動スキップ。
// 実行: npx vitest run src/level4.validation.test.ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { runPipelineOffline } from './core/offline';
import { evaluateLevel4, extractNoteEvents } from './core/exercise/level4';
import { SONGS, transposeSong } from './core/exercise/songs';
import { midiToSolfege } from './core/pitch/scale';

const DIR = 'recordings/level4';
// ユーザー実測の楽な範囲(ド3〜シ3。tasks/current.md 音域チェッククローズ時の値)
const USER_COMFORT = { lowMidi: 48, highMidi: 59 };

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

function noteName(midi: number): string {
  const r = Math.round(midi);
  return `${midiToSolfege(r)}${Math.floor(r / 12) - 1}`;
}

describe.skipIf(!existsSync(DIR))('level4 validation (user recordings)', () => {
  it('analyzes recordings against both songs', () => {
    const report: unknown[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.wav'))) {
      const { sampleRate, pcm } = decodeWav(readFileSync(join(DIR, file)));
      const { processed } = runPipelineOffline(pcm, sampleRate);
      const events = extractNoteEvents(processed);
      const perSong = SONGS.map((song) => {
        const targets = transposeSong(song, USER_COMFORT, null, 'low');
        const ev = evaluateLevel4(processed, targets);
        return {
          songId: song.id,
          targets: targets.map(noteName),
          measured: ev.measured,
          offsetCents: ev.offsetCents === null ? null : Math.round(ev.offsetCents),
          keyOffset: ev.keyOffset,
          melodyAccuracy: ev.melodyAccuracy,
          alignment: ev.alignment.map((a) => a.kind),
          firstIssueTargetIndex: ev.firstIssueTargetIndex,
        };
      });
      report.push({
        file,
        durS: +(pcm.length / sampleRate).toFixed(2),
        events: events.map((e) => ({
          note: noteName(e.midi),
          cents: Math.round((e.midi - Math.round(e.midi)) * 100),
          startMs: Math.round(e.startMs),
          voicedMs: Math.round(e.voicedMs),
        })),
        perSong,
      });
    }
    writeFileSync('recordings/level4_report.json', JSON.stringify(report, null, 2));
  });
});
