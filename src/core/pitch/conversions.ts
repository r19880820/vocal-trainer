// Hz <-> MIDI <-> cents 変換式。正本は docs/AUDIO_ANALYSIS.md §4。
// core/ は DOM/Web Audio 非依存の純関数のみ。

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Hz を実数 MIDI ノート番号に変換する。midi = 69 + 12*log2(hz/440) */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** 実数 MIDI ノート番号を Hz に変換する(hzToMidi の逆関数)。 */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** userHz が targetHz に対して何 cent ずれているか。cents = 1200*log2(userHz/targetHz) */
export function centsBetween(userHz: number, targetHz: number): number {
  return 1200 * Math.log2(userHz / targetHz);
}

/** 実数 MIDI ノート番号を最近傍の音名(例: 69→"A4", 60→"C4")に変換する。 */
export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const noteIndex = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}
