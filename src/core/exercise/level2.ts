// Level 2「1音合わせ」の ExerciseSpec 生成(TRAINING_MODEL.md「目標音の範囲」)
import type { ExerciseSpec } from '../types';
import { GUARD_AFTER_PLAYBACK_MS, PHONATION_MAX_S, REFERENCE_TONE_MS } from '../constants';

export type VoiceRange = 'low' | 'high';

// 低め: C3〜A3(48〜57)/ 高め: A3〜E4(57〜64)— 初回は出しやすい帯域に限定(仮値)
const RANGE_MIDI: Record<VoiceRange, [number, number]> = {
  low: [48, 57],
  high: [57, 64],
};

export function makeLevel2Spec(range: VoiceRange, midiNote?: number): ExerciseSpec {
  const [lo, hi] = RANGE_MIDI[range];
  const midi = midiNote ?? lo + Math.floor(Math.random() * (hi - lo + 1));
  return {
    exerciseId: `level2-${midi}-${Date.now()}`,
    levelId: 'level2',
    targets: [{ midiNote: midi, startMs: 0, durationMs: REFERENCE_TONE_MS }],
    phonationMaxMs: PHONATION_MAX_S * 1000,
    guardAfterPlaybackMs: GUARD_AFTER_PLAYBACK_MS,
  };
}
