// Level 2「1音合わせ」の ExerciseSpec 生成(TRAINING_MODEL.md「目標音の範囲」)
import type { ExerciseSpec } from '../types';
import { GUARD_AFTER_PLAYBACK_MS, PHONATION_MAX_S, REFERENCE_TONE_MS } from '../constants';
import { snapToCMajor } from '../pitch/scale';

export type VoiceRange = 'low' | 'high';

/** 音域チェックで測定済みの「楽に出せる範囲」(TRAINING_MODEL.md「目標音の範囲」)。 */
export interface ComfortRange {
  lowMidi: number;
  highMidi: number;
}

// 目標音は**ハ長調スケール上の音のみ**(2026-08-16 ユーザーフィードバック:
// 半音階の目標は初心者の耳に不自然。core/pitch/scale.ts 参照)。
// 低め: ド3〜ラ3の6音 / 高め: ラ3〜ミ4の5音
const RANGE_SCALE_MIDI: Record<VoiceRange, number[]> = {
  low: [48, 50, 52, 53, 55, 57], // C3 D3 E3 F3 G3 A3
  high: [57, 59, 60, 62, 64], // A3 B3 C4 D4 E4
};

// comfortRangeプールが3音未満の場合の再試行(TRAINING_MODEL.md「音域チェック済みの場合は測定値を優先」)
const COMFORT_POOL_MIN_NOTES = 3;
const COMFORT_POOL_WIDEN_STEP_SEMITONES = 2;
const COMFORT_POOL_MAX_WIDEN_ATTEMPTS = 2;

function isCMajorMidi(midi: number): boolean {
  return snapToCMajor(midi) === midi;
}

/** [lowMidi, highMidi](両端含む)内のハ長調スケール音を昇順で列挙する。 */
function scalePoolWithin(lowMidi: number, highMidi: number): number[] {
  const pool: number[] = [];
  for (let m = Math.ceil(lowMidi); m <= Math.floor(highMidi); m++) {
    if (isCMajorMidi(m)) pool.push(m);
  }
  return pool;
}

/**
 * comfortRangeがあればその範囲内のハ長調スケール音をプールにする。
 * 3音未満なら範囲を±2半音ずつ広げて再試行(最大2回)。それでも3音未満、または
 * comfortRange未指定なら従来のプリセットプールへフォールバックする。
 */
function resolvePool(range: VoiceRange, comfortRange?: ComfortRange | null): number[] {
  if (comfortRange) {
    let low = comfortRange.lowMidi;
    let high = comfortRange.highMidi;
    for (let attempt = 0; attempt <= COMFORT_POOL_MAX_WIDEN_ATTEMPTS; attempt++) {
      const pool = scalePoolWithin(low, high);
      if (pool.length >= COMFORT_POOL_MIN_NOTES) return pool;
      low -= COMFORT_POOL_WIDEN_STEP_SEMITONES;
      high += COMFORT_POOL_WIDEN_STEP_SEMITONES;
    }
  }
  return RANGE_SCALE_MIDI[range];
}

export function makeLevel2Spec(
  range: VoiceRange,
  midiNote?: number,
  comfortRange?: ComfortRange | null
): ExerciseSpec {
  const pool = resolvePool(range, comfortRange);
  const midi = midiNote ?? pool[Math.floor(Math.random() * pool.length)];
  return {
    exerciseId: `level2-${midi}-${Date.now()}`,
    levelId: 'level2',
    targets: [{ midiNote: midi, startMs: 0, durationMs: REFERENCE_TONE_MS }],
    phonationMaxMs: PHONATION_MAX_S * 1000,
    guardAfterPlaybackMs: GUARD_AFTER_PLAYBACK_MS,
  };
}
