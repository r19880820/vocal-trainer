// SONGS / transposeSong のテスト。TRAINING_MODEL.md「Level 4: 短いメロディ」v2。
import { describe, expect, it } from 'vitest';
import { SONGS, transposeSong, type Song } from './songs';
import { midiToSolfege } from '../pitch/scale';

function findSong(id: string): Song {
  const song = SONGS.find((s) => s.id === id);
  if (!song) throw new Error(`song not found: ${id}`);
  return song;
}

describe('SONGS data', () => {
  const tulip = findSong('tulip');
  const frog = findSong('frog');

  it('チューリップ: 「さいたさいた」6音節・幅4半音・休符1つ', () => {
    expect(tulip.notes).toHaveLength(6);
    expect(tulip.notes.map((n) => n.lyric).join('')).toBe('さいたさいた');
    expect(tulip.spanSemitones).toBe(4);
    const restCount = tulip.notes.filter((n) => (n.restAfterBeats ?? 0) > 0).length;
    expect(restCount).toBe(1);
  });

  it('チューリップ: degreeがハ長調(ドレミ␣ドレミ=0,2,4,0,2,4)と一致', () => {
    expect(tulip.notes.map((n) => n.degree)).toEqual([0, 2, 4, 0, 2, 4]);
  });

  it('チューリップ: solfegeが scale.ts の midiToSolfege(基準C4+degree) と整合する', () => {
    for (const n of tulip.notes) {
      expect(midiToSolfege(60 + n.degree)).toBe(n.solfege);
    }
  });

  it('かえるの合唱: 「かえるのうたが」7音節・幅5半音・休符なし', () => {
    expect(frog.notes).toHaveLength(7);
    expect(frog.notes.map((n) => n.lyric).join('')).toBe('かえるのうたが');
    expect(frog.spanSemitones).toBe(5);
    const restCount = frog.notes.filter((n) => (n.restAfterBeats ?? 0) > 0).length;
    expect(restCount).toBe(0);
  });

  it('かえるの合唱: degreeがハ長調(ドレミファミレド=0,2,4,5,4,2,0)と一致', () => {
    expect(frog.notes.map((n) => n.degree)).toEqual([0, 2, 4, 5, 4, 2, 0]);
  });

  it('かえるの合唱: solfegeが scale.ts の midiToSolfege と整合する', () => {
    for (const n of frog.notes) {
      expect(midiToSolfege(60 + n.degree)).toBe(n.solfege);
    }
  });

  it('spanSemitonesは実際の degree+12*octave の最大最小差と一致する', () => {
    for (const song of SONGS) {
      const pitches = song.notes.map((n) => n.degree + 12 * n.octave);
      const actualSpan = Math.max(...pitches) - Math.min(...pitches);
      expect(song.spanSemitones).toBe(actualSpan);
    }
  });
});

describe('transposeSong', () => {
  const tulip = findSong('tulip');

  it('ユーザー実測相当(comfortRange 48-59)でチューリップがオクターブ3(C3-B3)に収まる', () => {
    const midis = transposeSong(tulip, { lowMidi: 48, highMidi: 59 }, null, 'low');
    expect(midis).toEqual([48, 50, 52, 48, 50, 52]);
    for (const m of midis) {
      expect(m).toBeGreaterThanOrEqual(48);
      expect(m).toBeLessThanOrEqual(59);
    }
  });

  it('原曲がぴったり収まる範囲(59-66)では移調せずそのまま選ばれる', () => {
    // 原曲(C4基準)=60,62,64,60,62,64はすべて[59,66]内 -> overflow=0で最良。
    const midis = transposeSong(tulip, { lowMidi: 59, highMidi: 66 }, null, 'low');
    expect(midis).toEqual([60, 62, 64, 60, 62, 64]);
  });

  it('はみ出し総cent量が同点の場合は低い方のオクターブを選ぶ(タイブレーク)', () => {
    const singleNoteSong: Song = {
      id: 'test-single-note',
      title: 'test',
      subtitle: 'test',
      notes: [{ degree: 0, octave: 0, durationBeats: 1, lyric: 'ど', solfege: 'ド' }],
      spanSemitones: 0,
    };
    // shift=-12 -> 48(下に6半音はみ出す) / shift=0 -> 60(上に6半音はみ出す) で同点。
    // 低い方(48)を選ぶ規則を確認する。
    const midis = transposeSong(singleNoteSong, { lowMidi: 54, highMidi: 54 }, null, 'low');
    expect(midis).toEqual([48]);
  });

  it('comfortRangeが無くfullRangeがあればfullRangeを使う', () => {
    const full = { lowMidi: 48, highMidi: 59 };
    const midis = transposeSong(tulip, null, full, 'low');
    expect(midis).toEqual([48, 50, 52, 48, 50, 52]);
  });

  it('comfortRangeが指定されればfullRangeより優先される', () => {
    const comfort = { lowMidi: 48, highMidi: 59 };
    const full = { lowMidi: 60, highMidi: 71 }; // comfortと重ならない別範囲
    const midis = transposeSong(tulip, comfort, full, 'low');
    expect(midis).toEqual([48, 50, 52, 48, 50, 52]);
  });

  it('comfortRange・fullRangeとも無ければプリセット(low/high)へフォールバックする', () => {
    const lowMidis = transposeSong(tulip, null, null, 'low'); // プリセットlow=48-57
    const highMidis = transposeSong(tulip, null, null, 'high'); // プリセットhigh=57-64
    expect(lowMidis).toEqual([48, 50, 52, 48, 50, 52]);
    expect(highMidis).toEqual([60, 62, 64, 60, 62, 64]);
  });
});
