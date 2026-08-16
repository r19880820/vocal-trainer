// Level 3「2音模倣」出題・判定。正本は docs/TRAINING_MODEL.md「Level 3: 2音模倣」/
// docs/AUDIO_ANALYSIS.md §8(L3_INTERVAL_OK_CENTS / INTERVAL_NORM_CENTS 定数)。
// 出題(帯域・間隔制約)とユーザー発声の分割ロジックは Level 1 と同一のため、level1.ts の
// 内部関数を export してそのまま再利用する(タスク仕様: 重複実装を避ける)。
import type { ProcessedPitchSample } from '../types';
import type { VoiceRange } from './level2';
import { classify, median, pickIntervalCandidates, resolvePool, splitVoicedSegments } from './level1';
import { sampleDurationsMs } from '../features/segment';
import {
  DIRECTION_SAME_CENTS,
  INTERVAL_NORM_CENTS,
  L1_FALLBACK_MIN_VOICED_MS,
  L1_SEGMENT_MIN_VOICED_MS,
  L3_INTERVAL_OK_CENTS,
} from '../constants';

export interface Level3Trial {
  aMidi: number;
  bMidi: number;
}

/**
 * 出題(A, B)を1つ生成する(TRAINING_MODEL.md「Level 3」出題)。
 * Level 1(makeLevel1Trial)と同じ帯域・間隔制約(comfortRange優先・プリセットへフォールバック、
 * |B−A| は L1_MIN〜MAX_INTERVAL_SEMITONES のスケール音)を level1.ts の関数で再現するが、
 * same 出題は無い(幅の練習のため常に上下どちらか — TRAINING_MODEL.md「Level 3」出題)。
 */
export function makeLevel3Trial(
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange
): Level3Trial {
  const preferredDirection: 'up' | 'down' = Math.random() < 0.5 ? 'down' : 'up';

  const primaryPool = resolvePool(comfortRange, range);
  const primaryAMidi = primaryPool[Math.floor(Math.random() * primaryPool.length)];
  const primaryPicked = pickIntervalCandidates(primaryPool, primaryAMidi, preferredDirection);
  if (primaryPicked !== null) {
    const bMidi = primaryPicked.candidates[Math.floor(Math.random() * primaryPicked.candidates.length)];
    return { aMidi: primaryAMidi, bMidi };
  }

  // フォールバック(実装判断・詳細は最終報告): 狭い comfortRange では両方向とも間隔制約内の候補が
  // 無いことがある(level1.ts の同型ケース。level1.test.ts で確認済み)。Level 1 はこの場合 same に
  // フォールバックするが、Level 3 には same が無いため、resolvePool(null, range) = プリセットプール
  // (RANGE_SCALE_MIDI)で選び直す。プリセットプールは「収録された全音についてどちらかの方向に必ず
  // 候補が存在する」ことを level3.test.ts のプロパティテストで検証している。
  const presetPool = resolvePool(null, range);
  const presetAMidi = presetPool[Math.floor(Math.random() * presetPool.length)];
  const presetPicked = pickIntervalCandidates(presetPool, presetAMidi, preferredDirection);
  if (presetPicked !== null) {
    const bMidi = presetPicked.candidates[Math.floor(Math.random() * presetPicked.candidates.length)];
    return { aMidi: presetAMidi, bMidi };
  }

  // 理論上到達しない最終防波堤(プリセットプールで到達すると上記の前提が崩れている異常系)。
  // 間隔制約を無視してでも same を出題しないことを優先し、プール内の異なる音を返す。
  const others = presetPool.filter((m) => m !== presetAMidi);
  const bMidi = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : presetAMidi + 1;
  return { aMidi: presetAMidi, bMidi };
}

export interface Level3Evaluation {
  /** 2音の高さが取れたか(セグメント2つ、または前半/後半フォールバックで測定できた)。 */
  measured: boolean;
  /** セグメント1(1音目)の中央値 vs A のcent差。オクターブ補正なしの素の値。 */
  firstNoteCents: number | null;
  /** セグメント2(2音目)の中央値 vs B のcent差。オクターブ補正なしの素の値。 */
  secondNoteCents: number | null;
  /** ユーザーが実際に歌った幅(セグメント2中央値 − セグメント1中央値、cent)。 */
  userIntervalCents: number | null;
  /** clamp(1 − |userIntervalCents − targetIntervalCents| / INTERVAL_NORM_CENTS, 0, 1)。 */
  intervalAccuracy: number | null;
  /** 方向一致(DIRECTION_SAME_CENTS基準、Level 1と同じ分類で比較)。 */
  directionOk: boolean | null;
  /** TRAINING_MODEL.md「Level 3」フィードバック優先順(1〜4)。 */
  feedback: 'direction' | 'interval' | 'offset' | 'good' | null;
  /** feedback='interval'/'offset' 時のみ非null。文言の「高く/低く」「高め/低め」の向きに使う。 */
  offsetDirection: 'high' | 'low' | null;
}

const NOT_MEASURED: Level3Evaluation = {
  measured: false,
  firstNoteCents: null,
  secondNoteCents: null,
  userIntervalCents: null,
  intervalAccuracy: null,
  directionOk: null,
  feedback: null,
  offsetDirection: null,
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

interface TwoNoteMedians {
  firstMidi: number;
  secondMidi: number;
}

/**
 * ユーザー発声から2音それぞれの中央値midiを求める(TRAINING_MODEL.md「Level 3」
 * 「ユーザー発声の分割: Level 1 と同じ」)。
 * 1) 有声 >= L1_SEGMENT_MIN_VOICED_MS のセグメントが2つ以上あれば先頭2セグメントの中央値midi。
 * 2) フォールバック: 区切りが取れない(つなげて歌った)場合、全voicedサンプルの最初/最後の1/3の
 *    中央値midi(有声合計 < L1_FALLBACK_MIN_VOICED_MS、または有声サンプル数<6 なら null=測定不能)。
 */
function splitTwoNoteMedians(processed: ProcessedPitchSample[]): TwoNoteMedians | null {
  const valid = splitVoicedSegments(processed).filter((seg) => seg.voicedMs >= L1_SEGMENT_MIN_VOICED_MS);
  if (valid.length >= 2) {
    return {
      firstMidi: median(valid[0].samples.map((s) => s.midiNote)),
      secondMidi: median(valid[1].samples.map((s) => s.midiNote)),
    };
  }

  const durations = sampleDurationsMs(processed);
  let totalVoicedMs = 0;
  const voiced: ProcessedPitchSample[] = [];
  for (let i = 0; i < processed.length; i++) {
    if (processed[i].voicing === 'voiced') {
      voiced.push(processed[i]);
      totalVoicedMs += durations[i];
    }
  }
  if (totalVoicedMs < L1_FALLBACK_MIN_VOICED_MS || voiced.length < 6) return null;

  const third = Math.max(1, Math.floor(voiced.length / 3));
  return {
    firstMidi: median(voiced.slice(0, third).map((s) => s.midiNote)),
    secondMidi: median(voiced.slice(voiced.length - third).map((s) => s.midiNote)),
  };
}

/**
 * Level 3「2音模倣」の評価(TRAINING_MODEL.md「Level 3」評価・フィードバック優先順)。
 * cents はオクターブ補正なしの素の値(仕様どおり)。
 * フィードバック優先順:
 *   1. 方向不一致 → 'direction'
 *   2. |userIntervalCents − targetIntervalCents| > L3_INTERVAL_OK_CENTS → 'interval'
 *      (offsetDirection: 誤差が負=2つ目を高く/正=2つ目を低く。up/downどちらの方向でも
 *      secondMidi基準の差分の符号がそのまま「2つ目をどちらへ動かすか」に対応するため、
 *      方向で場合分けする必要はない)
 *   3. 幅はOKだが両音が同方向に |DIRECTION_SAME_CENTS| 超ずれ(50cent — TRAINING_MODEL.mdの
 *      「50cent」はタスク仕様上の値でありAUDIO_ANALYSIS.md定数表に専用定数が無いため、
 *      同じ意味で既に使われている DIRECTION_SAME_CENTS を再利用する。詳細は最終報告)→ 'offset'
 *   4. それ以外 → 'good'
 */
export function evaluateLevel3(processed: ProcessedPitchSample[], trial: Level3Trial): Level3Evaluation {
  const split = splitTwoNoteMedians(processed);
  if (split === null) return NOT_MEASURED;

  const { firstMidi, secondMidi } = split;
  const firstNoteCents = (firstMidi - trial.aMidi) * 100;
  const secondNoteCents = (secondMidi - trial.bMidi) * 100;
  const userIntervalCents = (secondMidi - firstMidi) * 100;
  const targetIntervalCents = (trial.bMidi - trial.aMidi) * 100;
  const intervalErrorCents = userIntervalCents - targetIntervalCents;
  const intervalAccuracy = clamp01(1 - Math.abs(intervalErrorCents) / INTERVAL_NORM_CENTS);

  // 出題は same 無しのため targetIntervalCents は必ず非ゼロ(up/downのどちらか)。
  const targetDirection: 'up' | 'down' = targetIntervalCents > 0 ? 'up' : 'down';
  const userDirection = classify(userIntervalCents); // 'up' | 'down' | 'same'(DIRECTION_SAME_CENTS基準)
  const directionOk = userDirection === targetDirection;

  const base = { measured: true as const, firstNoteCents, secondNoteCents, userIntervalCents, intervalAccuracy, directionOk };

  if (!directionOk) {
    return { ...base, feedback: 'direction', offsetDirection: null };
  }

  if (Math.abs(intervalErrorCents) > L3_INTERVAL_OK_CENTS) {
    const offsetDirection: 'high' | 'low' = intervalErrorCents < 0 ? 'high' : 'low';
    return { ...base, feedback: 'interval', offsetDirection };
  }

  const bothOffsetSameDirection =
    Math.abs(firstNoteCents) > DIRECTION_SAME_CENTS &&
    Math.abs(secondNoteCents) > DIRECTION_SAME_CENTS &&
    Math.sign(firstNoteCents) === Math.sign(secondNoteCents);
  if (bothOffsetSameDirection) {
    const offsetDirection: 'high' | 'low' = firstNoteCents < 0 ? 'high' : 'low';
    return { ...base, feedback: 'offset', offsetDirection };
  }

  return { ...base, feedback: 'good', offsetDirection: null };
}
