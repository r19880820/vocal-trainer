// Level 4「うたのフレーズ」の曲データ・移調。正本は docs/TRAINING_MODEL.md「Level 4: 短いメロディ」v2。
// core/ は DOM 禁止・純関数のみ(AGENTS.md)。
import type { VoiceRange } from './level2';

export interface SongNote {
  /** C=0基準の半音度数(C major内。ド=0/レ=2/ミ=4/ファ=5/ソ=7/ラ=9/シ=11) */
  degree: number;
  /** 曲内でのオクターブ(0=基準オクターブ、1=その1オクターブ上)。今回の2曲はいずれも0のみ(跳躍≤9半音・単一オクターブ内)。 */
  octave: 0 | 1;
  durationBeats: number;
  lyric: string;
  solfege: string;
  /** この音の後に置く休符の長さ(拍)。無ければ休符なし。 */
  restAfterBeats?: number;
}

export interface Song {
  id: string;
  title: string;
  subtitle: string;
  notes: SongNote[];
  /** 曲の必要音域幅(半音)。degree+12*octave の最大-最小と一致する(songs.test.ts で検証)。 */
  spanSemitones: number;
}

// 曲データはオクターブ非依存の内部基準点(C4=60)からの相対値として保持し、
// transposeSong で実際のユーザー音域に合わせて移調する。
const SONG_BASE_MIDI = 60; // C4。曲データ内の絶対値そのものに意味はなく、範囲との相対位置だけが問題になる。

// 第1弾: チューリップ「さいたさいた」(ドレミ␣ドレミ、幅4半音)。
// TRAINING_MODEL.md「Level 4」M-7裁定: 歌詞で歌う(「んー」でも可・強制しない)。
const TULIP: Song = {
  id: 'tulip',
  title: 'チューリップ',
  subtitle: 'さいたさいた',
  notes: [
    { degree: 0, octave: 0, durationBeats: 1, lyric: 'さ', solfege: 'ド' },
    { degree: 2, octave: 0, durationBeats: 1, lyric: 'い', solfege: 'レ' },
    // 「ドレミ␣ドレミ」の休符(␣)はここに付随する(SongNote自体を1個増やさない設計)。
    { degree: 4, octave: 0, durationBeats: 1, lyric: 'た', solfege: 'ミ', restAfterBeats: 1 },
    { degree: 0, octave: 0, durationBeats: 1, lyric: 'さ', solfege: 'ド' },
    { degree: 2, octave: 0, durationBeats: 1, lyric: 'い', solfege: 'レ' },
    { degree: 4, octave: 0, durationBeats: 1, lyric: 'た', solfege: 'ミ' },
  ],
  spanSemitones: 4, // ド(0)〜ミ(4)
};

// 第1弾: かえるの合唱「かえるのうたが」(ドレミファミレド、幅5半音)。休符なし。
const FROG: Song = {
  id: 'frog',
  title: 'かえるの合唱',
  subtitle: 'かえるのうたが',
  notes: [
    { degree: 0, octave: 0, durationBeats: 1, lyric: 'か', solfege: 'ド' },
    { degree: 2, octave: 0, durationBeats: 1, lyric: 'え', solfege: 'レ' },
    { degree: 4, octave: 0, durationBeats: 1, lyric: 'る', solfege: 'ミ' },
    { degree: 5, octave: 0, durationBeats: 1, lyric: 'の', solfege: 'ファ' },
    { degree: 4, octave: 0, durationBeats: 1, lyric: 'う', solfege: 'ミ' },
    { degree: 2, octave: 0, durationBeats: 1, lyric: 'た', solfege: 'レ' },
    { degree: 0, octave: 0, durationBeats: 1, lyric: 'が', solfege: 'ド' },
  ],
  spanSemitones: 5, // ド(0)〜ファ(5)
};

export const SONGS: Song[] = [TULIP, FROG];

interface MidiRange {
  lowMidi: number;
  highMidi: number;
}

// comfort/full 両方未指定時のフォールバック(TRAINING_MODEL.md「目標音の範囲」プリセットと同一帯域:
// 低め=ド3〜ラ3(48-57) / 高め=ラ3〜ミ4(57-64)。level2.ts の RANGE_SCALE_MIDI と同じ境界)。
const PRESET_RANGE: Record<VoiceRange, MidiRange> = {
  low: { lowMidi: 48, highMidi: 57 },
  high: { lowMidi: 57, highMidi: 64 },
};

// オクターブ単位の移調で探索する範囲(±4オクターブ。実用的な声域を十分カバーする)。
const MAX_OCTAVE_SHIFT = 4;

function resolveTargetRange(
  comfortRange: MidiRange | null,
  fullRange: MidiRange | null,
  range: VoiceRange
): MidiRange {
  if (comfortRange) return comfortRange;
  if (fullRange) return fullRange;
  return PRESET_RANGE[range];
}

/**
 * 曲をユーザーの音域に合わせて移調する(TRAINING_MODEL.md「Level 4」)。
 * **オクターブ単位の移調のみ**(半音単位のシフトはしない — 曲の音程関係を保つため)。
 * 選択基準: 範囲からのはみ出し**総cent量**が最小になるオクターブシフト。
 * 同点(はみ出し総量が等しい)の場合は**低い方**(出しやすい方)を選ぶ。
 * range探索の優先順: comfortRange → fullRange → プリセット(low/high)。
 * 戻り値は song.notes と同じ長さの実MIDI列(休符は notes に対応する要素を持たないため配列には現れない)。
 */
export function transposeSong(
  song: Song,
  comfortRange: MidiRange | null,
  fullRange: MidiRange | null,
  range: VoiceRange
): number[] {
  const target = resolveTargetRange(comfortRange, fullRange, range);
  const basePitches = song.notes.map((n) => SONG_BASE_MIDI + n.degree + 12 * n.octave);

  let bestShift = 0;
  let bestOverflowCents = Infinity;
  // 低い方から高い方へ走査することで、同点時は自動的に「最初に見つかった=最も低い」シフトが残る
  // (更新条件を厳密未満にしているため、同値の後発シフトでは上書きしない)。
  for (let shift = -MAX_OCTAVE_SHIFT * 12; shift <= MAX_OCTAVE_SHIFT * 12; shift += 12) {
    const overflowCents = basePitches.reduce((sum, m) => {
      const pitch = m + shift;
      const under = Math.max(0, target.lowMidi - pitch);
      const over = Math.max(0, pitch - target.highMidi);
      return sum + (under + over) * 100;
    }, 0);
    if (overflowCents < bestOverflowCents) {
      bestOverflowCents = overflowCents;
      bestShift = shift;
    }
  }

  return basePitches.map((m) => m + bestShift);
}
