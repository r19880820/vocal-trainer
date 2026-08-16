// Level 2「1音合わせ」の ExerciseSpec 生成(TRAINING_MODEL.md「目標音の範囲」)
import type { ExerciseSpec } from '../types';
import { GUARD_AFTER_PLAYBACK_MS, PHONATION_MAX_S, REFERENCE_TONE_MS } from '../constants';

export type VoiceRange = 'low' | 'high';

// 目標音は**ハ長調スケール上の音のみ**(2026-08-16 ユーザーフィードバック:
// 半音階の目標は初心者の耳に不自然。core/pitch/scale.ts 参照)。
// 低め: ド3〜ラ3の6音 / 高め: ラ3〜ミ4の5音
const RANGE_SCALE_MIDI: Record<VoiceRange, number[]> = {
  low: [48, 50, 52, 53, 55, 57], // C3 D3 E3 F3 G3 A3
  high: [57, 59, 60, 62, 64], // A3 B3 C4 D4 E4
};

export function makeLevel2Spec(range: VoiceRange, midiNote?: number): ExerciseSpec {
  const pool = RANGE_SCALE_MIDI[range];
  const midi = midiNote ?? pool[Math.floor(Math.random() * pool.length)];
  return {
    exerciseId: `level2-${midi}-${Date.now()}`,
    levelId: 'level2',
    targets: [{ midiNote: midi, startMs: 0, durationMs: REFERENCE_TONE_MS }],
    phonationMaxMs: PHONATION_MAX_S * 1000,
    guardAfterPlaybackMs: GUARD_AFTER_PLAYBACK_MS,
  };
}
