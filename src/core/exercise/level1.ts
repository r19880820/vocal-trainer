// Level 1「音の上下」出題・判定。正本は docs/TRAINING_MODEL.md「Level 1: 音の上下」/
// docs/AUDIO_ANALYSIS.md §8(L1_* / DIRECTION_SAME_CENTS 定数)。
// core/ は DOM 禁止・純関数のみ(AGENTS.md)。exercise/ は上位の調整役として features/ の
// 公開APIを使ってよい(ARCHITECTURE.md 依存ルール: audio < pitch < processing < features <
// scoring < diagnosis < training、exerciseは上位から各公開APIを使う)。
import type { ProcessedPitchSample } from '../types';
import type { VoiceRange } from './level2';
import { snapToCMajor } from '../pitch/scale';
import { sampleDurationsMs } from '../features/segment';
import {
  DIRECTION_SAME_CENTS,
  L1_FALLBACK_MIN_VOICED_MS,
  L1_MAX_INTERVAL_SEMITONES,
  L1_MIN_INTERVAL_SEMITONES,
  L1_SAME_PROB,
  L1_SEGMENT_GAP_MS,
  L1_SEGMENT_MIN_VOICED_MS,
} from '../constants';

export type Direction = 'up' | 'down' | 'same';

export interface Level1Trial {
  aMidi: number;
  bMidi: number;
  direction: Direction;
}

// Level 2(makeLevel2Spec)のプリセットプールと同じ帯域(TRAINING_MODEL.md「Level 1」出題:
// 「Aはユーザーの『楽に出せる範囲』のスケール音からランダム。無ければ声域プリセット」)。
// level2.ts はこの配列を export していないためここに複製する(値の正本は
// TRAINING_MODEL.md「目標音の範囲」— 低め: ド3〜ラ3の6音 / 高め: ラ3〜ミ4の5音。
// level2.ts 側の値を変更した場合はここも追随させること)。
const RANGE_SCALE_MIDI: Record<VoiceRange, number[]> = {
  low: [48, 50, 52, 53, 55, 57], // C3 D3 E3 F3 G3 A3
  high: [57, 59, 60, 62, 64], // A3 B3 C4 D4 E4
};

function isCMajorMidi(midi: number): boolean {
  return snapToCMajor(midi) === midi;
}

/** [lowMidi, highMidi](両端含む)内のハ長調スケール音を昇順で列挙する(level2.tsのscalePoolWithinと同型)。 */
function scaleNotesInRange(lowMidi: number, highMidi: number): number[] {
  const pool: number[] = [];
  for (let m = Math.ceil(lowMidi); m <= Math.floor(highMidi); m++) {
    if (isCMajorMidi(m)) pool.push(m);
  }
  return pool;
}

/** Level 3(level3.ts)から再利用するため export する(TRAINING_MODEL.md「Level 3」出題はLevel 1と同一制約 — 重複実装を避ける)。 */
export function resolvePool(comfortRange: { lowMidi: number; highMidi: number } | null, range: VoiceRange): number[] {
  if (comfortRange) {
    const pool = scaleNotesInRange(comfortRange.lowMidi, comfortRange.highMidi);
    if (pool.length > 0) return pool;
  }
  return RANGE_SCALE_MIDI[range];
}

interface CandidatePick {
  candidates: number[];
  direction: 'up' | 'down';
}

/**
 * aMidi から見て |B−A| が L1_MIN〜MAX_INTERVAL_SEMITONES に収まるプール内候補を
 * 優先方向(preferredDirection)から探す。無ければ反対方向を試す
 * (TRAINING_MODEL.md「候補が無い方向は反対方向へ」)。
 * 両方向とも候補が無ければ null を返す(呼び出し側で same にフォールバックする —
 * 実装判断。仕様書はこのケースを明記していないが、狭い comfortRange 指定時に理論上
 * 到達しうるため安全側として same を返す。詳細は最終報告)。
 */
/** Level 3(level3.ts)から再利用するため export する(同一の帯域・間隔制約 — 重複実装を避ける)。 */
export function pickIntervalCandidates(
  pool: number[],
  aMidi: number,
  preferredDirection: 'up' | 'down'
): CandidatePick | null {
  const up = pool.filter(
    (m) => m > aMidi && m - aMidi >= L1_MIN_INTERVAL_SEMITONES && m - aMidi <= L1_MAX_INTERVAL_SEMITONES
  );
  const down = pool.filter(
    (m) => m < aMidi && aMidi - m >= L1_MIN_INTERVAL_SEMITONES && aMidi - m <= L1_MAX_INTERVAL_SEMITONES
  );
  const primary = preferredDirection === 'up' ? up : down;
  if (primary.length > 0) return { candidates: primary, direction: preferredDirection };
  const secondary = preferredDirection === 'up' ? down : up;
  if (secondary.length > 0) {
    return { candidates: secondary, direction: preferredDirection === 'up' ? 'down' : 'up' };
  }
  return null;
}

/**
 * 出題(A, B, 正解方向)を1つ生成する(TRAINING_MODEL.md「Level 1」出題)。
 * A: comfortRange優先(無ければLevel 2と同じプリセット帯域)のスケール音からランダム。
 * B: 確率 L1_SAME_PROB で B=A(same)。それ以外は上下ランダムに、|B−A| が
 * L1_MIN〜MAX_INTERVAL_SEMITONES のスケール音(範囲内)を選ぶ。
 */
export function makeLevel1Trial(
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange
): Level1Trial {
  const pool = resolvePool(comfortRange, range);
  const aMidi = pool[Math.floor(Math.random() * pool.length)];

  if (Math.random() < L1_SAME_PROB) {
    return { aMidi, bMidi: aMidi, direction: 'same' };
  }

  const preferredDirection: 'up' | 'down' = Math.random() < 0.5 ? 'down' : 'up';
  const picked = pickIntervalCandidates(pool, aMidi, preferredDirection);
  if (picked === null) {
    // 候補が両方向とも無い(狭いcomfortRange等) — 実装判断: sameへフォールバックする(最終報告参照)
    return { aMidi, bMidi: aMidi, direction: 'same' };
  }
  const bMidi = picked.candidates[Math.floor(Math.random() * picked.candidates.length)];
  return { aMidi, bMidi, direction: picked.direction };
}

export interface DirectionEvaluation {
  detected: Direction | null;
  deltaCents: number | null;
  /** L1_SEGMENT_MIN_VOICED_MS 以上の有声合計を持つセグメント数(短すぎるセグメントは含まない)。 */
  segments: number;
}

interface VoicedSegment {
  samples: ProcessedPitchSample[];
  voicedMs: number;
}

/**
 * voiced区間を「非voicedが L1_SEGMENT_GAP_MS 以上続いたら分割」でセグメント化する
 * (TRAINING_MODEL.md「ユーザー発声の分割」)。閾値未満の短い非voiced区間はセグメントを
 * またがず同一セグメントとして扱う(息継ぎ等の短いブレを許容)。返す各セグメントの samples は
 * voiced サンプルのみ(非voicedサンプル自体はギャップ判定にのみ使い、中央値計算には含めない)。
 */
/** Level 3(level3.ts)から再利用するため export する(ユーザー発声の分割ロジックはLevel 1と同一 — TRAINING_MODEL.md「Level 3」)。 */
export function splitVoicedSegments(samples: ProcessedPitchSample[]): VoicedSegment[] {
  const durations = sampleDurationsMs(samples);
  const segments: VoicedSegment[] = [];
  let current: ProcessedPitchSample[] = [];
  let currentVoicedMs = 0;
  let gapMs = 0;

  const flush = () => {
    if (current.length > 0) segments.push({ samples: current, voicedMs: currentVoicedMs });
    current = [];
    currentVoicedMs = 0;
    gapMs = 0;
  };

  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing === 'voiced') {
      current.push(samples[i]);
      currentVoicedMs += durations[i];
      gapMs = 0;
    } else if (current.length > 0) {
      gapMs += durations[i];
      if (gapMs >= L1_SEGMENT_GAP_MS) flush();
    }
  }
  flush();

  return segments;
}

/** Level 3(level3.ts)から再利用するため export する。 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Level 3(level3.ts)がユーザーの2音間cent差の分類(up/down/same判定)に再利用するため export する。 */
export function classify(deltaCents: number): Direction {
  return Math.abs(deltaCents) <= DIRECTION_SAME_CENTS ? 'same' : deltaCents > 0 ? 'up' : 'down';
}

/**
 * ユーザー発声から方向を判定する(TRAINING_MODEL.md「ユーザー発声の分割」)。
 * 1) 区切りが取れた場合(有声 >= L1_SEGMENT_MIN_VOICED_MS のセグメントが2つ以上):
 *    先頭2セグメントの midi中央値の差(cent)で判定(最も正確)。
 * 2) **フォールバック(2026-08-16 実地事故対応)**: 「んーんー」とつなげて歌う/区切りが
 *    短い場合はセグメントが1つに融合する。その場合、全voicedサンプルを時系列で並べ、
 *    最初の1/3 と 最後の1/3 の midi中央値の差で判定する(連続スライドでも方向は取れる)。
 *    有声合計 < L1_FALLBACK_MIN_VOICED_MS なら測定不能(detected=null)。
 */
export function evaluateDirection(processed: ProcessedPitchSample[]): DirectionEvaluation {
  const valid = splitVoicedSegments(processed).filter((seg) => seg.voicedMs >= L1_SEGMENT_MIN_VOICED_MS);
  if (valid.length >= 2) {
    const firstMidi = median(valid[0].samples.map((s) => s.midiNote));
    const secondMidi = median(valid[1].samples.map((s) => s.midiNote));
    const deltaCents = (secondMidi - firstMidi) * 100;
    return { detected: classify(deltaCents), deltaCents, segments: valid.length };
  }

  // フォールバック: 前半 vs 後半
  const durations = sampleDurationsMs(processed);
  let totalVoicedMs = 0;
  const voiced: ProcessedPitchSample[] = [];
  for (let i = 0; i < processed.length; i++) {
    if (processed[i].voicing === 'voiced') {
      voiced.push(processed[i]);
      totalVoicedMs += durations[i];
    }
  }
  if (totalVoicedMs < L1_FALLBACK_MIN_VOICED_MS || voiced.length < 6) {
    return { detected: null, deltaCents: null, segments: valid.length };
  }
  const third = Math.max(1, Math.floor(voiced.length / 3));
  const firstMidi = median(voiced.slice(0, third).map((s) => s.midiNote));
  const secondMidi = median(voiced.slice(voiced.length - third).map((s) => s.midiNote));
  const deltaCents = (secondMidi - firstMidi) * 100;
  return { detected: classify(deltaCents), deltaCents, segments: valid.length };
}
