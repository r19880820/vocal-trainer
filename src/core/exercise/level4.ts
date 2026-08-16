// Level 4「うたのフレーズ」評価コア。正本は docs/TRAINING_MODEL.md「Level 4: 短いメロディ」v2
// (評価アルゴリズム5段階)/ docs/AUDIO_ANALYSIS.md §8(L4_* 定数。実録音検証M-3まで全て仮値)。
// このファイルは評価コアのみ(UI・捕捉ウィンドウ制御・お手本再生は対象外 — Opus設計レビュー条件:
// 「実録音検証を通過するまでUIに進まない」に従う段階実装)。
import type { ProcessedPitchSample } from '../types';
import { analyzePhonation, sampleDurationsMs } from '../features/segment';
import {
  L4_EVENT_BREAK_MS,
  L4_KEY_OFFSET_CENTS,
  L4_NOTE_MIN_MS,
  L4_NOTE_OK_CENTS,
  L4_NOTE_STABLE_CENTS,
  L4_VALID_MIN_VOICED_MS,
} from '../constants';

export interface NoteEvent {
  /** 実数(イベント内サンプルの時間重み付き中央値)。 */
  midi: number;
  startMs: number;
  voicedMs: number;
}

// 隣接同一音を畳む際の許容差(半音)。タスク仕様は「0.5半音」固定値だが、
// L4_NOTE_STABLE_CENTS(50cent=0.5半音)と数値上一致するためこちらを介して表現する
// (ノートイベント抽出の「安定」しきい値と「同一音」しきい値を意図的に揃える設計判断。詳細は最終報告)。
const COLLAPSE_SEMITONE_TOLERANCE = L4_NOTE_STABLE_CENTS / 100;

// 各voicedランの先頭でこの時間(ms)は捨てる(子音直後の不安定 — TRAINING_MODEL.md M-1③)。
// AUDIO_ANALYSIS.md §8の定数表には未登録の固定値(タスク仕様の指示どおり。曖昧点として最終報告に記載)。
const RUN_LEADING_TRIM_MS = 50;

interface RunSample {
  sample: ProcessedPitchSample;
  /** このサンプル自身の時間幅(ms)。sampleDurationsMs と同じ定義(直前サンプルからの間隔)。 */
  durationMs: number;
}

/**
 * 非voicedが L4_EVENT_BREAK_MS 以上続いたら分断する形で voiced ラン(の集合)を作る
 * (M-1①)。level1.ts の splitVoicedSegments と同型だが、Level 4 は別しきい値
 * (L4_EVENT_BREAK_MS)を使うため独立実装する(既存coreモジュールは変更しない — タスク制約)。
 */
function splitVoicedRuns(samples: ProcessedPitchSample[]): RunSample[][] {
  const durations = sampleDurationsMs(samples);
  const runs: RunSample[][] = [];
  let current: RunSample[] = [];
  let gapMs = 0;

  const flush = () => {
    if (current.length > 0) runs.push(current);
    current = [];
    gapMs = 0;
  };

  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing === 'voiced') {
      current.push({ sample: samples[i], durationMs: durations[i] });
      gapMs = 0;
    } else if (current.length > 0) {
      gapMs += durations[i];
      if (gapMs >= L4_EVENT_BREAK_MS) flush();
    }
  }
  flush();

  return runs;
}

/** ランの先頭 RUN_LEADING_TRIM_MS ぶんのサンプルを捨てる(M-1③)。 */
function trimRunLeading(run: RunSample[]): RunSample[] {
  let elapsed = 0;
  let idx = 0;
  while (idx < run.length && elapsed < RUN_LEADING_TRIM_MS) {
    elapsed += run[idx].durationMs;
    idx++;
  }
  return run.slice(idx);
}

/** weight(時間幅)付きの中央値。累積重みが総重みの半分に達した最初の値を返す標準的な定義。 */
function timeWeightedMedian(items: Array<{ value: number; weight: number }>): number {
  if (items.length === 0) return 0;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1].value + sorted[mid].value) / 2 : sorted[mid].value;
  }
  const half = totalWeight / 2;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= half) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * トリム済みランを、現在イベントの時間重み付き中央値から ±L4_NOTE_STABLE_CENTS 外れたら
 * 新イベントとする形で走査する(M-1②)。
 */
function splitRunIntoEvents(run: RunSample[]): RunSample[][] {
  const events: RunSample[][] = [];
  let current: RunSample[] = [];

  for (const rs of run) {
    if (current.length === 0) {
      current.push(rs);
      continue;
    }
    const runningMedianCents =
      timeWeightedMedian(current.map((c) => ({ value: c.sample.midiNote, weight: c.durationMs }))) * 100;
    const cents = rs.sample.midiNote * 100;
    if (Math.abs(cents - runningMedianCents) > L4_NOTE_STABLE_CENTS) {
      events.push(current);
      current = [rs];
    } else {
      current.push(rs);
    }
  }
  if (current.length > 0) events.push(current);

  return events;
}

/**
 * ノートイベント抽出(TRAINING_MODEL.md M-1確定仕様の5段階)。
 * ①非voicedが L4_EVENT_BREAK_MS 以上続いたらランを分断
 * ②ラン内を走査し、現イベントの時間重み付き中央値から ±L4_NOTE_STABLE_CENTS 外れたら新イベント
 * ③各ラン先頭 50ms は捨てる(②の走査より先に適用 — 子音直後の不安定なピッチが
 *   中央値やイベント境界に影響しないようにするため。詳細は最終報告)
 * ④有声 ≥ L4_NOTE_MIN_MS のみ採用
 * ⑤イベント値=時間重み付き中央値
 */
export function extractNoteEvents(processed: ProcessedPitchSample[]): NoteEvent[] {
  const runs = splitVoicedRuns(processed);
  const events: NoteEvent[] = [];

  for (const run of runs) {
    const trimmed = trimRunLeading(run);
    if (trimmed.length === 0) continue;

    for (const ev of splitRunIntoEvents(trimmed)) {
      const voicedMs = ev.reduce((sum, c) => sum + c.durationMs, 0);
      if (voicedMs < L4_NOTE_MIN_MS) continue;
      const midi = timeWeightedMedian(ev.map((c) => ({ value: c.sample.midiNote, weight: c.durationMs })));
      events.push({ midi, startMs: ev[0].sample.timestampMs, voicedMs });
    }
  }

  return events;
}

/**
 * 隣接同一音(|差|<=0.5半音)を畳む(C-1: 縮約正規化)。
 * 「ドド」を1回で伸ばして歌っても2回に区切って歌っても同じ結果になるための土台
 * (再アタック検出は加点にも減点にも使わない — TRAINING_MODEL.md)。
 * 比較は隣接する**入力**要素どうし(グループ代表値との比較ではない)。
 */
export function collapseRepeats(midis: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < midis.length; i++) {
    if (i === 0 || Math.abs(midis[i] - midis[i - 1]) > COLLAPSE_SEMITONE_TOLERANCE) {
      out.push(midis[i]);
    }
  }
  return out;
}

/**
 * NoteEvent[] 版の縮約(ユーザー側で使用)。collapseRepeats と同じグルーピング規則
 * (隣接する入力要素どうしの差で境界を決める)を使うが、統合後の値は
 * グループ内メンバーの時間重み付き中央値(voicedMsで重み付け)、voicedMsは合算、
 * startMs はグループ先頭を維持する。
 */
function collapseNoteEvents(events: NoteEvent[]): NoteEvent[] {
  if (events.length === 0) return [];

  const groups: NoteEvent[][] = [];
  let current: NoteEvent[] = [events[0]];
  for (let i = 1; i < events.length; i++) {
    if (Math.abs(events[i].midi - events[i - 1].midi) <= COLLAPSE_SEMITONE_TOLERANCE) {
      current.push(events[i]);
    } else {
      groups.push(current);
      current = [events[i]];
    }
  }
  groups.push(current);

  return groups.map((group) => ({
    midi: timeWeightedMedian(group.map((e) => ({ value: e.midi, weight: e.voicedMs }))),
    startMs: group[0].startMs,
    voicedMs: group.reduce((sum, e) => sum + e.voicedMs, 0),
  }));
}

export type AlignmentKind = 'match' | 'sub' | 'del' | 'ins';

export interface AlignmentEntry {
  kind: AlignmentKind;
  targetIndex: number | null;
  /** オフセット除去後の実数MIDI値(match/sub/insのみ非null。UI表示はこの値をそのまま音名化する想定)。 */
  userMidi: number | null;
  residualCents: number | null;
}

export interface Level4Evaluation {
  measured: boolean;
  offsetCents: number | null;
  keyOffset: boolean;
  alignment: AlignmentEntry[];
  melodyAccuracy: number | null;
  firstIssueTargetIndex: number | null;
}

const NOT_MEASURED: Level4Evaluation = {
  measured: false,
  offsetCents: null,
  keyOffset: false,
  alignment: [],
  melodyAccuracy: null,
  firstIssueTargetIndex: null,
};

type BackMove = 'diag' | 'del' | 'ins';

/**
 * 縮約後のユーザー系列(オフセット除去後・半音単位)と目標系列(半音単位)を
 * 編集距離(Needleman-Wunsch、≤9×9 DP)でアライメントする(C-2)。
 * コスト: match=0 / sub=1 / ins=1 / del=1。match判定は |残差cents| <= L4_NOTE_OK_CENTS。
 *
 * **tie-break規則**: 複数の遷移が同一最小コストを与える場合、
 * diagonal(match/sub) > del(目標を飛ばす) > ins(ユーザー超過音) の優先順で選ぶ。
 * 理由: (1) diagonal優先により「同じ長さの歌をsub 1個で説明できるのに ins+del 2個で
 * 説明する」ような不要な迂回を避ける(コスト計算上そもそも劣るため通常は発生しないが、
 * 探索順の安定性のため明示する)。(2) del/ins間のtieでは del(目標ノートが欠落)を優先する
 * — フィードバックは歌詞ベースの位置ヒントを前提とするため(UX_TRAINING.md §5f)、
 * 「目標のどこが欠けたか」の方が「どこに余分な音が入ったか」より一貫してユーザーに
 * 説明可能(目標歌詞に紐づくtargetIndexを常に持つため)。
 */
function alignSequences(userMidis: number[], targetMidis: number[]): AlignmentEntry[] {
  const m = userMidis.length;
  const n = targetMidis.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const back: BackMove[][] = Array.from({ length: m + 1 }, () => new Array<BackMove>(n + 1).fill('diag'));

  for (let i = 1; i <= m; i++) {
    dp[i][0] = i;
    back[i][0] = 'ins';
  }
  for (let j = 1; j <= n; j++) {
    dp[0][j] = j;
    back[0][j] = 'del';
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const residual = (userMidis[i - 1] - targetMidis[j - 1]) * 100;
      const diagCost = dp[i - 1][j - 1] + (Math.abs(residual) <= L4_NOTE_OK_CENTS ? 0 : 1);
      const delCost = dp[i][j - 1] + 1;
      const insCost = dp[i - 1][j] + 1;

      // tie-break: diag > del > ins(上記コメント参照。厳密未満の更新のみ行うことで優先順を実現)
      let best = diagCost;
      let bestMove: BackMove = 'diag';
      if (delCost < best) {
        best = delCost;
        bestMove = 'del';
      }
      if (insCost < best) {
        best = insCost;
        bestMove = 'ins';
      }
      dp[i][j] = best;
      back[i][j] = bestMove;
    }
  }

  const reversed: AlignmentEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const move: BackMove = i > 0 && j > 0 ? back[i][j] : i === 0 ? 'del' : 'ins';
    if (move === 'diag') {
      const residual = (userMidis[i - 1] - targetMidis[j - 1]) * 100;
      const kind: AlignmentKind = Math.abs(residual) <= L4_NOTE_OK_CENTS ? 'match' : 'sub';
      reversed.push({ kind, targetIndex: j - 1, userMidi: userMidis[i - 1], residualCents: residual });
      i--;
      j--;
    } else if (move === 'del') {
      reversed.push({ kind: 'del', targetIndex: j - 1, userMidi: null, residualCents: null });
      j--;
    } else {
      reversed.push({ kind: 'ins', targetIndex: null, userMidi: userMidis[i - 1], residualCents: null });
      i--;
    }
  }

  return reversed.reverse();
}

/**
 * アライメント結果から最初の不一致(sub/del/ins)の縮約後目標indexを求める(フィードバック用)。
 * sub/delは自身のtargetIndexをそのまま使う。insはtargetIndexを持たないため、
 * 直後(無ければ直前)の非null targetIndexを位置ヒントとして採用する(実装判断。最終報告参照)。
 */
function findFirstIssueTargetIndex(alignment: AlignmentEntry[]): number | null {
  for (let k = 0; k < alignment.length; k++) {
    const entry = alignment[k];
    if (entry.kind === 'match') continue;
    if (entry.targetIndex !== null) return entry.targetIndex;

    for (let after = k + 1; after < alignment.length; after++) {
      if (alignment[after].targetIndex !== null) return alignment[after].targetIndex;
    }
    for (let before = k - 1; before >= 0; before--) {
      if (alignment[before].targetIndex !== null) return alignment[before].targetIndex;
    }
    return null;
  }
  return null;
}

/**
 * Level 4「うたのフレーズ」の評価(TRAINING_MODEL.md「Level 4」評価5段階)。
 * targetMidis は曲の実MIDI列(縮約前。休符に対応する要素は含まない — songs.ts の transposeSong 参照)。
 * 手順: ノートイベント抽出 → ユーザー/目標を縮約 → 時間重み付き中央値差でオフセット推定・除去
 * → 編集距離アライメント(match=|残差cents|<=L4_NOTE_OK_CENTS) → melodyAccuracy。
 * ハードな音名スナップは一切しない。
 */
export function evaluateLevel4(processed: ProcessedPitchSample[], targetMidis: number[]): Level4Evaluation {
  const events = extractNoteEvents(processed);
  const voicedMs = analyzePhonation(processed).voicedMs;

  // validity(M-10): 有声合計 < L4_VALID_MIN_VOICED_MS または抽出イベント<2 → 測定不能
  if (voicedMs < L4_VALID_MIN_VOICED_MS || events.length < 2) {
    return NOT_MEASURED;
  }

  const userCollapsed = collapseNoteEvents(events);
  const targetCollapsed = collapseRepeats(targetMidis);

  // グローバル・オフセット除去(C-3/C-4): 縮約後系列どうしの時間重み付き中央値差。
  // ユーザー側は各ノートのvoicedMsで重み付け、目標側は音価(拍)情報をこの関数は持たないため
  // 等重み(=単純中央値。重み1のtimeWeightedMedianは単純中央値と等価)で扱う。
  const userMedianCents = timeWeightedMedian(userCollapsed.map((e) => ({ value: e.midi * 100, weight: e.voicedMs })));
  const targetMedianCents = timeWeightedMedian(targetCollapsed.map((midi) => ({ value: midi * 100, weight: 1 })));
  const offsetCents = userMedianCents - targetMedianCents;
  const keyOffset = Math.abs(offsetCents) > L4_KEY_OFFSET_CENTS;

  const adjustedUserMidis = userCollapsed.map((e) => e.midi - offsetCents / 100);
  const alignment = alignSequences(adjustedUserMidis, targetCollapsed);

  const matchCount = alignment.filter((entry) => entry.kind === 'match').length;
  // melodyAccuracy の分母=縮約後**目標**音数(keyOffset時も算出する)。
  const melodyAccuracy = targetCollapsed.length > 0 ? matchCount / targetCollapsed.length : null;

  return {
    measured: true,
    offsetCents,
    keyOffset,
    alignment,
    melodyAccuracy,
    firstIssueTargetIndex: findFirstIssueTargetIndex(alignment),
  };
}
