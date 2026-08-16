// 「今日のメニュー」編成。正本は docs/TRAINING_MODEL.md「今日のメニュー(セッション化)」/
// docs/UX_TRAINING.md §5e(文言はこのまま使う)。
// core/ の調整役(exercise・progress 同様、DOM禁止・純関数のみ。ARCHITECTURE.md 依存ルール)。
// 将来 AI Coach に差し替え可能なよう、入出力は構造化データのみ(Settings由来の値+SkillSnapshot[] → MenuStep[])。
import type { ExerciseSpec, SkillSnapshot } from '../types';
import { makeLevel2Spec, type VoiceRange } from '../exercise/level2';
import { resolvePool } from '../exercise/level1';
import { noteBreakdown, weeklyBySkill, type NoteStat } from '../progress/aggregate';
import { snapToCMajor, midiToSolfege } from '../pitch/scale';
import {
  MENU_WARMUP_PHONATION_MS,
  MENU_WARMUP_TONE_MS,
  MENU_WEAK_SKILL_THRESHOLD,
  NOTE_MIN_COUNT,
} from '../constants';

export type MenuStepKind = 'warmupLongTone' | 'level2Focus' | 'level1Set' | 'level3Trial' | 'finisher';

export interface MenuStep {
  kind: MenuStepKind;
  /** 画面表示タイトル(UX_TRAINING.md §5e M-1。例: 「今日の重点 — ソ3の集中練習」) */
  title: string;
  /** 1行の理由文(UX §5e M-1) */
  reason: string;
  /** warmupLongTone / level2Focus / finisher のみ(Level 2実行仕様)。level1Set / level3Trial は
   * 実行側(Level1Screen / Level3Screen)が自前で出題するため spec を持たない。 */
  spec?: ExerciseSpec;
}

export interface BuildDailyMenuInput {
  comfortRange: { lowMidi: number; highMidi: number } | null;
  range: VoiceRange;
  snapshots: SkillSnapshot[];
}

// UX_TRAINING.md §5e M-1 の文言(そのまま使用)。
const WARMUP_REASON = '楽な高さでロングトーン。「んー」でもリップロールでもOK';
const WORST_NOTE_REASON = 'のびしろの音です。集中して合わせましょう';
const LEVEL1_REASON = '聞き分けの練習をつづけましょう';
const FINISHER_REASON = 'とくいな音で気持ちよく締めましょう';
// UX_TRAINING.md §5e にM-1例文が無い2ケースの補完文言(実装判断・最終報告に明記)。
const RANDOM_NOTE_REASON = 'いろいろな高さに慣れていきましょう';
const LEVEL3_REASON = '音の幅をつかむ練習をつづけましょう';

/** 実数MIDI→標準MIDIオクターブ番号(60=C4)。TrainingApp.tsx の octaveOf と同型(core は ui/ を参照できないため複製)。 */
function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

function noteLabel(midi: number): string {
  return `${midiToSolfege(midi)}${octaveOf(midi)}`;
}

/** 「楽な範囲の中央に最も近いスケール音」(TRAINING_MODEL.md「今日のメニュー」①)。
 * comfortRange があればその中央を snapToCMajor。無ければプリセットプール(resolvePool経由)の中央。 */
function resolveCenterMidi(comfortRange: { lowMidi: number; highMidi: number } | null, range: VoiceRange): number {
  if (comfortRange) {
    return snapToCMajor((comfortRange.lowMidi + comfortRange.highMidi) / 2);
  }
  const pool = resolvePool(null, range);
  return snapToCMajor((pool[0] + pool[pool.length - 1]) / 2);
}

function buildWarmupStep(comfortRange: { lowMidi: number; highMidi: number } | null, range: VoiceRange, centerMidi: number): MenuStep {
  const base = makeLevel2Spec(range, centerMidi, comfortRange);
  const spec: ExerciseSpec = {
    ...base,
    targets: [{ ...base.targets[0], durationMs: MENU_WARMUP_TONE_MS }],
    phonationMaxMs: MENU_WARMUP_PHONATION_MS,
  };
  return { kind: 'warmupLongTone', title: 'こえのじゅんび', reason: WARMUP_REASON, spec };
}

function level2FocusStep(
  midi: number,
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange,
  reason: string
): MenuStep {
  return {
    kind: 'level2Focus',
    title: `今日の重点 — ${noteLabel(midi)}の集中練習`,
    reason,
    spec: makeLevel2Spec(range, midi, comfortRange),
  };
}

function level1SetStep(): MenuStep {
  return { kind: 'level1Set', title: '今日の重点 — 音の上下', reason: LEVEL1_REASON };
}

function level3TrialStep(): MenuStep {
  return { kind: 'level3Trial', title: '今日の重点 — 2音まねっこ', reason: LEVEL3_REASON };
}

/** count>=NOTE_MIN_COUNT の音のうち medianAbsCents が最大(最悪)の音。無ければ null。 */
function pickWorstNote(notes: NoteStat[]): NoteStat | null {
  if (notes.length === 0) return null;
  return notes.reduce((worst, n) => (n.medianAbsCents > worst.medianAbsCents ? n : worst));
}

/** count>=NOTE_MIN_COUNT の音のうち medianAbsCents が最小(最良)の音。無ければ null。 */
function pickBestNote(notes: NoteStat[]): NoteStat | null {
  if (notes.length === 0) return null;
  return notes.reduce((best, n) => (n.medianAbsCents < best.medianAbsCents ? n : best));
}

/** プールから usedMidis に無い音をランダムに1つ選び、usedMidis へ追加する(同種重複回避)。
 * 全音が使用済みなら実装上の保険としてプール全体から選び直す(狭いcomfortRange対策)。 */
function pickRandomUnusedMidi(
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange,
  usedMidis: Set<number>
): number {
  const pool = resolvePool(comfortRange, range);
  const candidates = pool.filter((m) => !usedMidis.has(m));
  const effectivePool = candidates.length > 0 ? candidates : pool;
  const midi = effectivePool[Math.floor(Math.random() * effectivePool.length)];
  usedMidis.add(midi);
  return midi;
}

/**
 * 今日の重点(2ステップ、TRAINING_MODEL.md「今日のメニュー」②③)。優先順 a→b→c、
 * 埋まらない分は d(Level 2ランダム、同種重複回避)。
 * a/b/c いずれの判定材料も無い(=noteBreakdown/weeklyBySkill が現行paramsVersionで使える
 * データを1件も返さない。snapshots=[] の初回起動だけでなく、直近の較正更新で全履歴が
 * バージョン不一致除外された直後も含む)場合は、a/b/c の閾値評価が意味を持たないため、
 * 仕様の明示的な指定どおり [Level 2ランダム, Level 1セット] を直接返す
 * (仕様「データ無し初心者は a=Level 2ランダム, b=Level1」の実装 — 一般アルゴリズムに委ねると
 * a/b/c 全てが不発になり d が2回連続でLevel 2ランダムを埋めてしまい、初心者に単調な体験を
 * 与えてしまうための明示的な早期分岐。詳細は最終報告)。
 */
function buildFocusSteps(
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange,
  snapshots: SkillSnapshot[],
  usedMidis: Set<number>
): MenuStep[] {
  // a) 最悪の音 — **現在のプール内の音に限定**(Codexレビュー指摘: 音域測定の更新や
  // 低め/高め切替後、過去履歴の音が現在の楽な範囲外のまま出題されていた)
  const poolSet = new Set(resolvePool(comfortRange, range));
  const notes = noteBreakdown(snapshots).filter((n) => n.count >= NOTE_MIN_COUNT && poolSet.has(n.midi));
  const worst = pickWorstNote(notes);

  const weekly = weeklyBySkill(snapshots);
  const directionMedian = weekly.directionAccuracy?.[0]?.median;
  const intervalMedian = weekly.intervalAccuracy?.[0]?.median;

  if (worst === null && directionMedian === undefined && intervalMedian === undefined) {
    const randomMidi = pickRandomUnusedMidi(comfortRange, range, usedMidis);
    return [level2FocusStep(randomMidi, comfortRange, range, RANDOM_NOTE_REASON), level1SetStep()];
  }

  const steps: MenuStep[] = [];
  if (worst) {
    steps.push(level2FocusStep(worst.midi, comfortRange, range, WORST_NOTE_REASON));
    usedMidis.add(worst.midi);
  }

  // b) directionAccuracy 弱め → Level 1
  if (steps.length < 2 && directionMedian !== undefined && directionMedian < MENU_WEAK_SKILL_THRESHOLD) {
    steps.push(level1SetStep());
  }

  // c) intervalAccuracy 弱め → Level 3
  if (steps.length < 2 && intervalMedian !== undefined && intervalMedian < MENU_WEAK_SKILL_THRESHOLD) {
    steps.push(level3TrialStep());
  }

  // d) 埋まらない分は Level 2ランダム(同種重複回避)
  while (steps.length < 2) {
    const midi = pickRandomUnusedMidi(comfortRange, range, usedMidis);
    steps.push(level2FocusStep(midi, comfortRange, range, RANDOM_NOTE_REASON));
  }

  return steps;
}

/** しあげ(TRAINING_MODEL.md「今日のメニュー」④)。最良音(count>=NOTE_MIN_COUNT・medianAbsCents最小)。
 * **現在のプール内かつ「重点」で使っていない音を優先**(Codexレビュー指摘: 統計対象が1音だけだと
 * 重点と仕上げが同一になっていた)。ウォームアップ(中央音)との重複は許容する — 練習の種類が
 * 違い(ロングトーン vs 通常)、成功体験で締める目的にはむしろ好適。候補が尽きた場合のみ
 * 重点との重複も許す(狭いプールの最終保険)。 */
function buildFinisherStep(
  comfortRange: { lowMidi: number; highMidi: number } | null,
  range: VoiceRange,
  snapshots: SkillSnapshot[],
  centerMidi: number,
  focusMidis: Set<number>
): MenuStep {
  const pool = resolvePool(comfortRange, range);
  const poolSet = new Set(pool);
  const notes = noteBreakdown(snapshots).filter((n) => n.count >= NOTE_MIN_COUNT && poolSet.has(n.midi));

  const bestUnused = pickBestNote(notes.filter((n) => !focusMidis.has(n.midi)));
  let midi: number;
  if (bestUnused) {
    midi = bestUnused.midi;
  } else if (!focusMidis.has(centerMidi)) {
    midi = centerMidi;
  } else {
    const alternatives = pool.filter((m) => !focusMidis.has(m));
    midi =
      alternatives.length > 0
        ? alternatives[Math.floor(Math.random() * alternatives.length)]
        : (pickBestNote(notes)?.midi ?? centerMidi);
  }
  return {
    kind: 'finisher',
    title: `しあげ — ${noteLabel(midi)}`,
    reason: FINISHER_REASON,
    spec: makeLevel2Spec(range, midi, comfortRange),
  };
}

/** 今日のメニュー(4ステップ固定)を編成する(TRAINING_MODEL.md「今日のメニュー」)。 */
export function buildDailyMenu(input: BuildDailyMenuInput): MenuStep[] {
  const { comfortRange, range, snapshots } = input;
  const centerMidi = resolveCenterMidi(comfortRange, range);

  // 使用済み音の共有(Codexレビュー指摘対応): 重点のランダム選出はウォームアップ(中央音)と
  // 重複させない。しあげは「重点で使った音」だけを避ける(中央音との重複は許容 — buildFinisherStep参照)。
  // データ駆動の「最悪音」選出だけは重複より優先する
  const usedMidis = new Set<number>([centerMidi]);
  const warmupStep = buildWarmupStep(comfortRange, range, centerMidi);
  const focusSteps = buildFocusSteps(comfortRange, range, snapshots, usedMidis);
  const focusMidis = new Set([...usedMidis].filter((m) => m !== centerMidi));
  const finisherStep = buildFinisherStep(comfortRange, range, snapshots, centerMidi, focusMidis);

  return [warmupStep, ...focusSteps, finisherStep];
}
