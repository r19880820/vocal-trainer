// Level 4「うたのフレーズ」本番UI。画面フロー・文言の正本は docs/UX_TRAINING.md §5f、
// 出題・評価仕様は docs/TRAINING_MODEL.md「Level 4: 短いメロディ」v2。
// Level1Screen.tsx / Level3Screen.tsx と同じ土台(録音→オフライン解析・👂/🎤合図・静音500ms連結・
// cancelledRefガード)を踏襲するが、Level 4 独自の点が2つある:
// (1) お手本再生が単音の繰り返しではなく AudioSession.playMelody による1本のタイムライン再生
// (2) 捕捉が固定時間ではなく、session.start の onRaw ストリームを自前の PitchProcessor で
//     ライブ監視し、有声確認後の無音 L4_SILENCE_END_MS で早期終了する(タスク仕様)。
// session は親(TrainingApp)から受け取り、このコンポーネント自身はマイクの生成/破棄
// (session.start以外)を行わない(session.stop()の呼び出しは親の責務)。
import { useEffect, useRef, useState } from 'react';
import { AudioSession, melodySchedule, type MelodyNote } from '../platform/audioSession';
import { runPipelineOffline } from '../core/offline';
import { PitchProcessor } from '../core/processing/processor';
import type { RawPitchSample, Voicing } from '../core/types';
import {
  collapseRepeats,
  evaluateLevel4,
  type AlignmentEntry,
  type Level4Evaluation,
} from '../core/exercise/level4';
import { SONGS, transposeSong, type Song } from '../core/exercise/songs';
import type { VoiceRange } from '../core/exercise/level2';
import { midiToHz } from '../core/pitch/conversions';
import { midiToSolfege } from '../core/pitch/scale';
import { loadSettings, type Settings } from '../data/settings';
import { createProgressStore } from '../data/progressStore';
import {
  GUARD_AFTER_PLAYBACK_MS,
  L4_CAPTURE_PER_NOTE_MS,
  L4_CAPTURE_TAIL_MS,
  L4_NOTE_GAP_MS,
  L4_NOTE_STABLE_CENTS,
  L4_REPEAT_GAP_MS,
  L4_SILENCE_END_MS,
  L4_TONE_MS,
  NOISE_MEASURE_MS,
  RANGE_MIN_COMFORT_BINS,
} from '../core/constants';

interface Props {
  session: AudioSession;
  /** 「← やめる/ホームへ」共通の離脱コールバック(ホームへ戻る)。 */
  onBack: () => void;
  /** 「今日のメニュー」実行中(TrainingApp)から渡される進捗ラベル。今回はTrainingAppからの配線は
   * しない(タスク仕様: メニュー統合は次段)が、L1/L3と同じ契約を保つためprops自体は用意する。 */
  menuLabel?: string;
  /** 「今日のメニュー」実行中のみ渡される想定(現状は未配線)。あれば結果画面の主ボタンが
   * [つぎのメニューへ]になる(L1/L3と同型)。 */
  onComplete?: () => void;
}

// localStorage を包むだけの薄いラッパーなのでモジュールスコープで1つ生成すれば十分(ADR-004。
// TrainingApp.tsx 等のインスタンスとは別だが、同一key('vt.progress.v1')を包むだけなので実質共有と等価)。
const progressStore = createProgressStore();

type Phase =
  | 'songSelect' // L4-1
  | 'preparing' // マイク起動中(過渡)
  | 'micDenied'
  | 'preSilence' // 静音500ms(ノイズ測定・録音して保持)
  | 'measureRetry' // measured=false 時の1回だけの自動再挑戦案内(L1/L3のfeedback相当)
  | 'playing' // L4-2 お手本再生
  | 'capturing' // L4-2 🎤捕捉
  | 'judging' // オフライン解析中
  | 'result'; // L4-3

/** フィードバック表示の最小視認時間(UX_TRAINING.md §5c「1.5秒表示して自動で次へ」— L1/L3と同じ値を
 * measured=false時の再挑戦案内表示にのみ使う。L4専用のUI都合値のためLevel1/3Screen.tsxと同様
 * ここにローカル定義する — constants.tsに追記する指定はタスク仕様の定数一覧に含まれていない)。 */
const L4_FEEDBACK_DISPLAY_MS = 1500;

/** 測定不能(§3.5系。原因を区別できないため汎用文言をベースに、L4は歌詞/んー両方を許すことを明示する
 * よう文言を調整する — L1/L3が「んー、んー」向けに調整しているのと同じ実装判断。詳細は最終報告)。 */
const MEASURE_RETRY_TEXT = 'もう少し長めに、歌詞か「んー」で歌ってみてください。もう一度どうぞ';

/** 1回の自動再挑戦後もmeasured=falseだった場合のフォールバック文言(L1/L3の汎用測定不能文言を再利用)。 */
const MEASURE_FAIL_TEXT_LINES = [
  '声をうまく聞き取れませんでした。',
  '次は「声の届け方」を意識してみましょう',
  'マイクの近くで、はっきり・長めに「んー」と声を出してみましょう',
];

/** 捕捉の上限到達時、終端がvoicedのまま(=まだ歌っている途中で打ち切った)なら「欠落」フィードバックを
 * 出さない(TRAINING_MODEL.md「捕捉」— fail-closed)。歌い方の矯正要求はしない方針(M-4)のため、
 * テンポ等への言及はせず中立な再挑戦文言にする。 */
const TRUNCATED_RETRY_TEXT = 'うまく録れませんでした。もう一度どうぞ';

const NO_EVAL: Level4Evaluation = {
  measured: false,
  offsetCents: null,
  keyOffset: false,
  alignment: [],
  melodyAccuracy: null,
  firstIssueTargetIndex: null,
};

interface MidiRange {
  lowMidi: number;
  highMidi: number;
}

/** 音域チェック済みか(TrainingApp.tsx / Level1Screen.tsx / Level3Screen.tsx の hasMeasuredRange と
 * 同条件。Level4Screenも props を {session, onBack, ...} に固定する指定のため、共有ヘルパー化は
 * せずここに複製する — 詳細は最終報告)。 */
function hasMeasuredComfort(
  s: Settings
): s is Settings & { rangeComfortLowMidi: number; rangeComfortHighMidi: number } {
  return (
    s.rangeComfortLowMidi !== null &&
    s.rangeComfortHighMidi !== null &&
    s.rangeComfortHighMidi - s.rangeComfortLowMidi + 1 >= RANGE_MIN_COMFORT_BINS
  );
}

/** 「がんばれば」範囲が保存済みか。comfortと違い異常値対策の幅ガードは掛けない
 * (RANGE_MIN_COMFORT_BINSは「楽な範囲」専用の後方互換ガードであり、full側には元々適用されていない)。 */
function hasMeasuredFull(s: Settings): s is Settings & { rangeFullLowMidi: number; rangeFullHighMidi: number } {
  return s.rangeFullLowMidi !== null && s.rangeFullHighMidi !== null;
}

function resolveRanges(s: Settings): { comfortRange: MidiRange | null; fullRange: MidiRange | null; range: VoiceRange } {
  return {
    comfortRange: hasMeasuredComfort(s) ? { lowMidi: s.rangeComfortLowMidi, highMidi: s.rangeComfortHighMidi } : null,
    fullRange: hasMeasuredFull(s) ? { lowMidi: s.rangeFullLowMidi, highMidi: s.rangeFullHighMidi } : null,
    range: s.range ?? 'low',
  };
}

/** L4-1: transposeSongの最良移調でも「楽に出せる範囲」に収まりきらない曲かどうか(UX_TRAINING.md §5f)。
 * comfort未測定なら比較対象が無いため常にfalse(選べなくはしない、の前提どおり警告も出さない)。 */
function songOverflowsComfort(song: Song, settings: Settings): boolean {
  const { comfortRange, fullRange, range } = resolveRanges(settings);
  if (!comfortRange) return false;
  const midis = transposeSong(song, comfortRange, fullRange, range);
  return midis.some((m) => m < comfortRange.lowMidi || m > comfortRange.highMidi);
}

/**
 * songs.ts の音価・休符から MelodyNote[] を構築する(TRAINING_MODEL.md「Level 4」お手本再生仕様)。
 * 1拍=L4_TONE_MS、同音連続の後は L4_REPEAT_GAP_MS、それ以外は L4_NOTE_GAP_MS、休符は
 * その分 L4_TONE_MS×restAfterBeats をgapへ加算する。最終音の長さは1.4倍。
 */
function buildMelodyNotes(song: Song, targetMidis: number[]): MelodyNote[] {
  return song.notes.map((note, i) => {
    const isLast = i === song.notes.length - 1;
    const baseDurationMs = L4_TONE_MS * note.durationBeats;
    const durationMs = isLast ? baseDurationMs * 1.4 : baseDurationMs;
    let gapAfterMs = 0;
    if (!isLast) {
      const sameAsNext = Math.abs(targetMidis[i] - targetMidis[i + 1]) < 0.001;
      gapAfterMs = sameAsNext ? L4_REPEAT_GAP_MS : L4_NOTE_GAP_MS;
    }
    gapAfterMs += (note.restAfterBeats ?? 0) * L4_TONE_MS;
    return { hz: midiToHz(targetMidis[i]), durationMs, gapAfterMs };
  });
}

// level4.ts の collapseRepeats と同じ隣接比較規則(|差|<=L4_NOTE_STABLE_CENTS)で、縮約後の
// 各グループ代表(先頭)の song.notes インデックスを求める(歌詞表示専用)。level4.ts は
// 縮約後の値しか返さずインデックスを返さないため、結果表示(歌詞ヒント)のためだけにUI側で
// 複製する(level4.ts/songs.ts は変更しない制約のため。同じ定数を参照するので閾値はズレない)。
const COLLAPSE_TOLERANCE_SEMITONES = L4_NOTE_STABLE_CENTS / 100;
function collapseIndices(midis: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < midis.length; i++) {
    if (i === 0 || Math.abs(midis[i] - midis[i - 1]) > COLLAPSE_TOLERANCE_SEMITONES) out.push(i);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** L4-3のフィードバック文言(TRAINING_MODEL.md「Level 4」優先順を厳守: keyOffset → 全match → 最初のsub
 * → 最初のdel)。sub/delは evaluation.firstIssueTargetIndex ではなく alignment を直接走査して求める
 * ——firstIssueTargetIndexはins(挿入)の位置ヒント解決を含み、「最初のsub/del」というpriority classの
 * 意味とズレる場合があるため(詳細は最終報告)。 */
function resultMessage(
  song: Song,
  collapsedIdx: number[],
  evaluation: Level4Evaluation,
  truncatedWhileVoiced: boolean
): { text: string; showFirstNoteBtn: boolean } {
  if (evaluation.keyOffset) {
    return { text: 'メロディの形は合っています!出だしの高さだけ合わせてみましょう', showFirstNoteBtn: true };
  }
  const allMatched = evaluation.alignment.every((e) => e.kind === 'match' || e.kind === 'ins');
  if (allMatched) {
    return { text: 'メロディが歌えています!', showFirstNoteBtn: false };
  }
  const firstSub = evaluation.alignment.find((e) => e.kind === 'sub');
  if (firstSub && firstSub.targetIndex !== null && firstSub.residualCents !== null) {
    const lyric = song.notes[collapsedIdx[firstSub.targetIndex]]?.lyric ?? '';
    const word = firstSub.residualCents > 0 ? '高く' : '低く';
    return { text: `『${lyric}』のところが${word}なりました。そこだけ気をつけてもう一回`, showFirstNoteBtn: false };
  }
  const firstDel = evaluation.alignment.find((e) => e.kind === 'del');
  if (firstDel && firstDel.targetIndex !== null) {
    if (truncatedWhileVoiced) {
      return { text: TRUNCATED_RETRY_TEXT, showFirstNoteBtn: false };
    }
    const lyric = song.notes[collapsedIdx[firstDel.targetIndex]]?.lyric ?? '';
    return { text: `『${lyric}』のあたりをもう一度きいてみましょう`, showFirstNoteBtn: false };
  }
  // 到達しない想定(sub/delが1つも無ければ全target match=allMatched分岐で既に返している)。
  // 型安全のためのフォールバック。
  return { text: 'メロディが歌えています!', showFirstNoteBtn: false };
}

const page: React.CSSProperties = {
  padding: 20,
  fontFamily: 'sans-serif',
  maxWidth: 440,
  margin: '0 auto',
  minHeight: '100dvh',
  boxSizing: 'border-box',
};
const bigBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  fontSize: 20,
  padding: '16px 20px',
  borderRadius: 14,
  border: 'none',
  background: '#2e7d32',
  color: '#fff',
  marginTop: 16,
  cursor: 'pointer',
};
const subBtn: React.CSSProperties = {
  ...bigBtn,
  background: '#e8eaee',
  color: '#333',
};
const card: React.CSSProperties = {
  background: '#f4f4f6',
  borderRadius: 14,
  padding: '16px 18px',
  marginTop: 16,
};
const chip = (ok: boolean): React.CSSProperties => ({
  border: `2px solid ${ok ? '#2e7d32' : '#ccc'}`,
  borderRadius: 10,
  padding: '6px 10px',
  textAlign: 'center',
  minWidth: 44,
  flex: '0 0 auto',
});

/** menuLabelがあれば画面上部に小さく表示する共通スニペット(UX_TRAINING.md §5e M-2。L1/L3と同型)。 */
function MenuLabel({ menuLabel }: { menuLabel: string | undefined }) {
  if (!menuLabel) return null;
  return <p style={{ textAlign: 'center', fontSize: 12, color: '#aaa' }}>{menuLabel}</p>;
}

export function Level4Screen({ session, onBack, menuLabel, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('songSelect');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [targetMidis, setTargetMidis] = useState<number[]>([]);
  const [noteIndex, setNoteIndex] = useState(0);
  const [remainingMs, setRemainingMs] = useState(0);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Level4Evaluation | null>(null);
  const [truncatedWhileVoiced, setTruncatedWhileVoiced] = useState(false);

  // 開始直後に録音した静音PCM(ノイズフロア推定用)。オフライン解析時にこの先頭へ連結する(L1/L3と同じ作法)。
  const silenceRef = useRef<{ sampleRate: number; pcm: Float32Array } | null>(null);
  // session.start()が返す内部レート(ライブ捕捉監視用PitchProcessorの生成に必要)。
  const internalRateRef = useRef(0);
  // preSilence中に推定したノイズフロアdB(ライブ捕捉監視専用。最終採点は runPipelineOffline が
  // 録音済みPCMから自前推定するため、ここでの推定は「いつ捕捉を打ち切るか」の判断にのみ使う)。
  const noiseFloorRef = useRef(-80);
  // 現在アクティブな「onRawストリームの購読者」(preSilence中のdB収集 / capturing中のライブ監視)。
  // session.start に渡すコールバックは1つだけなので、フェーズごとにこのrefへ差し替える。
  const captureLiveRef = useRef<((raw: RawPitchSample) => void) | null>(null);
  // capturing中のみ非null。「🔊 もう一度きく」ボタンから捕捉を中断してplaying段階からやり直す。
  const restartCaptureRef = useRef<(() => void) | null>(null);
  // アンマウント後にawait継続分がstateを書き換えないためのガード(session.stop()は親の責務)。
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      // 捕捉待ちのPromiseと上限タイマーを即時解決する(Codexレビュー中: アンマウント後も
      // 最大~11秒タイマーが残る問題。restartループ側は cancelledRef で即終了する)
      restartCaptureRef.current?.();
    },
    []
  );

  const ensureSession = async (): Promise<boolean> => {
    if (session.running) return true;
    setPhase('preparing');
    try {
      const info = await session.start(
        (raw) => captureLiveRef.current?.(raw),
        (m) => setErrorMsg(m)
      );
      internalRateRef.current = info.internalSampleRate;
      return true;
    } catch (e) {
      if (cancelledRef.current) return false;
      setPhase('micDenied');
      setErrorMsg(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  /** 静音500ms(ノイズ測定・録音して保持)。ライブ監視用ノイズフロアもここで同時に推定する。 */
  const runPreSilence = async (): Promise<boolean> => {
    setPhase('preSilence');
    const dbs: number[] = [];
    captureLiveRef.current = (raw) => {
      const db = raw.amplitude > 0 ? 20 * Math.log10(raw.amplitude) : -Infinity;
      if (Number.isFinite(db)) dbs.push(db);
    };
    session.setRecording(true);
    await sleep(NOISE_MEASURE_MS);
    session.setRecording(false);
    captureLiveRef.current = null;
    if (cancelledRef.current) return false;

    noiseFloorRef.current = dbs.length > 0 ? median(dbs) : -80;
    const silence = session.getRecording();
    if (!silence) {
      // 静音録音に失敗(仕様未定義の異常系 — Level1Screen/Level3Screenと同じ実装判断)。
      setPhase('songSelect');
      setErrorMsg('うまく準備できませんでした。もう一度お試しください');
      return false;
    }
    silenceRef.current = silence;
    return true;
  };

  type CaptureOutcome =
    | { kind: 'restart' }
    | { kind: 'result'; evaluation: Level4Evaluation; truncatedWhileVoiced: boolean };

  /** L4-2(お手本再生→ガード→🎤捕捉→オフライン解析)を1回実行する。 */
  const captureAttempt = async (song: Song, midis: number[]): Promise<CaptureOutcome> => {
    const notes = buildMelodyNotes(song, midis);
    const offsets = melodySchedule(notes);
    const lastDurationMs = notes[notes.length - 1].durationMs;
    const totalMs = offsets[offsets.length - 1] + lastDurationMs;

    setPhase('playing');
    setNoteIndex(0);
    setRemainingMs(totalMs);

    const uiTimers = notes.map((_, i) =>
      setTimeout(() => {
        if (!cancelledRef.current) setNoteIndex(i);
      }, offsets[i])
    );
    const startWall = performance.now();
    const remainInterval = setInterval(() => {
      const elapsed = performance.now() - startWall;
      setRemainingMs(Math.max(0, totalMs - elapsed));
    }, 200);

    await session.playMelody(notes);
    uiTimers.forEach(clearTimeout);
    clearInterval(remainInterval);
    setRemainingMs(0);
    if (cancelledRef.current) return { kind: 'result', evaluation: NO_EVAL, truncatedWhileVoiced: false };

    await sleep(GUARD_AFTER_PLAYBACK_MS);
    if (cancelledRef.current) return { kind: 'result', evaluation: NO_EVAL, truncatedWhileVoiced: false };

    setPhase('capturing');
    session.setRecording(true);

    const processor = new PitchProcessor(internalRateRef.current);
    processor.setNoiseFloorDb(noiseFloorRef.current);

    let hasVoiced = false;
    let lastVoicedMs: number | null = null;
    let lastVoicing: Voicing = 'silent';
    let hitUpperBound = false;
    let restartRequested = false;
    const upperBoundMs = notes.length * L4_CAPTURE_PER_NOTE_MS + L4_CAPTURE_TAIL_MS;

    await new Promise<void>((resolve) => {
      let settled = false;
      let upperTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (opts: { timedOut?: boolean; restart?: boolean }) => {
        if (settled) return;
        settled = true;
        if (upperTimer) clearTimeout(upperTimer);
        hitUpperBound = !!opts.timedOut;
        restartRequested = !!opts.restart;
        captureLiveRef.current = null;
        restartCaptureRef.current = null;
        resolve();
      };
      restartCaptureRef.current = () => finish({ restart: true });
      captureLiveRef.current = (raw) => {
        const p = processor.process(raw);
        lastVoicing = p.voicing;
        if (p.voicing === 'voiced') {
          hasVoiced = true;
          lastVoicedMs = p.timestampMs;
        }
        const sinceVoiced = lastVoicedMs !== null ? p.timestampMs - lastVoicedMs : 0;
        if (hasVoiced && sinceVoiced >= L4_SILENCE_END_MS) {
          finish({});
        }
      };
      upperTimer = setTimeout(() => finish({ timedOut: true }), upperBoundMs);
    });

    session.setRecording(false);
    if (restartRequested) return { kind: 'restart' };

    // cancelledチェックはsetPhaseより先(Codexレビュー中: アンマウント後のsetPhase実行防止)
    if (cancelledRef.current) return { kind: 'result', evaluation: NO_EVAL, truncatedWhileVoiced: false };
    setPhase('judging');

    const rec = session.getRecording();
    const silence = silenceRef.current;
    if (!rec || !silence) return { kind: 'result', evaluation: NO_EVAL, truncatedWhileVoiced: false };

    const combined = new Float32Array(silence.pcm.length + rec.pcm.length);
    combined.set(silence.pcm, 0);
    combined.set(rec.pcm, silence.pcm.length);
    const { processed } = runPipelineOffline(combined, rec.sampleRate);
    const silenceMs = (silence.pcm.length / rec.sampleRate) * 1000;
    const capturedProcessed = processed.filter((p) => p.timestampMs >= silenceMs);
    const result = evaluateLevel4(capturedProcessed, midis);

    return {
      kind: 'result',
      evaluation: result,
      // (lastVoicing as Voicing): TSがクロージャ経由の再代入をここまで追跡できず'silent'に
      // 過narrowingして「'voiced'とは重ならない」誤検知(TS2367)を出すための回避キャスト。
      truncatedWhileVoiced: hitUpperBound && (lastVoicing as Voicing) === 'voiced',
    };
  };

  /** captureAttemptを「🔊 もう一度きく」によるrestart要求が無くなるまで繰り返す。 */
  const captureWithRestartLoop = async (
    song: Song,
    midis: number[]
  ): Promise<{ evaluation: Level4Evaluation; truncatedWhileVoiced: boolean }> => {
    for (;;) {
      const outcome = await captureAttempt(song, midis);
      if (cancelledRef.current) return { evaluation: NO_EVAL, truncatedWhileVoiced: false };
      if (outcome.kind === 'restart') continue;
      return { evaluation: outcome.evaluation, truncatedWhileVoiced: outcome.truncatedWhileVoiced };
    }
  };

  /** L4-1の曲カードから呼ばれる: 曲1回分のフル実行(session確保→静音→捕捉→結果)。
   * 「もう一回」からも同じ関数を呼ぶ(L1/L3と同じ粒度で、毎回 preSilence を録り直す)。 */
  const runSongFlow = async (song: Song) => {
    setErrorMsg(null);
    setEvaluation(null);
    setSelectedSong(song);

    const started = await ensureSession();
    if (!started || cancelledRef.current) return;

    const preOk = await runPreSilence();
    if (!preOk || cancelledRef.current) return;

    const settings = loadSettings();
    const { comfortRange, fullRange, range } = resolveRanges(settings);
    const midis = transposeSong(song, comfortRange, fullRange, range);
    setTargetMidis(midis);

    let { evaluation: result, truncatedWhileVoiced: truncated } = await captureWithRestartLoop(song, midis);
    if (cancelledRef.current) return;

    if (!result.measured) {
      // measured=false: §3.5系文言+1回だけ自動再挑戦(TRAINING_MODEL.md「Level 4」フィードバック規則1)。
      setPhase('measureRetry');
      setFeedbackMsg(MEASURE_RETRY_TEXT);
      await sleep(L4_FEEDBACK_DISPLAY_MS);
      if (cancelledRef.current) return;

      const retried = await captureWithRestartLoop(song, midis);
      if (cancelledRef.current) return;
      result = retried.evaluation;
      truncated = retried.truncatedWhileVoiced;
    }

    if (result.measured && result.melodyAccuracy !== null) {
      progressStore.appendSnapshot(`melodyAccuracy:${song.id}`, result.melodyAccuracy, `level4-${song.id}-${Date.now()}`);
    }

    setEvaluation(result);
    setTruncatedWhileVoiced(truncated);
    setPhase('result');
  };

  // ---- L4-1 曲えらび ----
  if (phase === 'songSelect') {
    const settings = loadSettings();
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20 }}>うたのフレーズ</h2>
        <p>短い童謡のフレーズを、お手本のあとに続けて歌ってみましょう。歌詞でも「んー」でも大丈夫です。</p>
        {errorMsg && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#888' }}>{errorMsg}</p>
          </div>
        )}
        {SONGS.map((song) => {
          const overflow = songOverflowsComfort(song, settings);
          return (
            <div style={card} key={song.id}>
              <div style={{ fontSize: 14, color: '#888' }}>{song.subtitle}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{song.title}</div>
              {overflow && (
                <p style={{ fontSize: 12, color: '#888', marginTop: 4 }}>いまの音域だと少し広い曲です</p>
              )}
              <button style={{ ...bigBtn, marginTop: 12 }} onClick={() => void runSongFlow(song)}>
                この曲で練習する
              </button>
            </div>
          );
        })}
        <button style={subBtn} onClick={onBack}>
          ← もどる
        </button>
      </div>
    );
  }

  // ---- マイク起動中(過渡) ----
  if (phase === 'preparing') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <p style={{ textAlign: 'center', marginTop: 80 }}>準備中…</p>
      </div>
    );
  }

  // ---- マイク許可なし ----
  if (phase === 'micDenied') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <div style={card}>
          <p>マイクが使えないと練習できません。ブラウザの設定からマイクを許可してください。</p>
        </div>
        <button style={subBtn} onClick={onBack}>
          ← もどる
        </button>
      </div>
    );
  }

  // ---- 静音500ms(ノイズ測定) ----
  if (phase === 'preSilence') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <p style={{ textAlign: 'center', fontSize: 18, marginTop: 80 }}>そのまま静かに…</p>
        <button style={{ ...subBtn, marginTop: 60 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- measured=false: 1回だけの自動再挑戦案内 ----
  if (phase === 'measureRetry') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <div style={{ ...card, marginTop: 80 }}>
          <p style={{ fontSize: 17, fontWeight: 700, textAlign: 'center' }}>{feedbackMsg}</p>
        </div>
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- L4-2 お手本再生 ----
  if (phase === 'playing' && selectedSong) {
    const note = selectedSong.notes[Math.min(noteIndex, selectedSong.notes.length - 1)];
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20, textAlign: 'center' }}>{selectedSong.title}</h2>
        <p style={{ textAlign: 'center', fontSize: 13, color: '#888', marginTop: 24 }}>👂 聞いて…</p>
        <p style={{ textAlign: 'center', fontSize: 24, fontWeight: 700, marginTop: 8 }}>
          ♪{noteIndex + 1}/{selectedSong.notes.length} {note.solfege}『{note.lyric}』
        </p>
        <p style={{ textAlign: 'center', fontSize: 14, color: '#888', marginTop: 8 }}>
          のこり {Math.max(0, Math.ceil(remainingMs / 1000))}秒
        </p>
        <p style={{ textAlign: 'center', fontSize: 13, color: '#888', marginTop: 4 }}>さいごまで聞いてから</p>
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- L4-2 🎤捕捉 ----
  if (phase === 'capturing' && selectedSong) {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20, textAlign: 'center' }}>{selectedSong.title}</h2>
        <p style={{ textAlign: 'center', fontSize: 19, fontWeight: 700, color: '#2e7d32', marginTop: 40 }}>
          🎤 いま!歌詞で歌ってみましょう(『んー』でも大丈夫)
        </p>
        <button style={{ ...subBtn, marginTop: 24 }} onClick={() => restartCaptureRef.current?.()}>
          🔊 もう一度きく
        </button>
        {/* 「🎵 最初の音だけもう一度」は捕捉中には出さない(Codexレビュー高: 捕捉中に鳴らすと
            お手本音が録音・採点・早期終了判定に混入する)。キーずれの結果画面でのみ提供 */}
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- オフライン解析中 ----
  if (phase === 'judging') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <p style={{ textAlign: 'center', fontSize: 18, marginTop: 80 }}>…</p>
      </div>
    );
  }

  // ---- L4-3 結果 ----
  if (phase === 'result' && selectedSong) {
    const measured = evaluation !== null && evaluation.measured;
    if (!measured) {
      return (
        <div style={page}>
          <MenuLabel menuLabel={menuLabel} />
          <div style={card}>
            <p>
              {MEASURE_FAIL_TEXT_LINES[0]}
              <br />
              {MEASURE_FAIL_TEXT_LINES[1]}
              <br />
              {MEASURE_FAIL_TEXT_LINES[2]}
            </p>
          </div>
          {onComplete && (
            <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onComplete}>
              つぎのメニューへ
            </button>
          )}
          <button style={bigBtn} onClick={() => void runSongFlow(selectedSong)}>
            もう一回
          </button>
          {!onComplete && (
            <button style={{ ...bigBtn, background: '#1565c0' }} onClick={() => setPhase('songSelect')}>
              べつの曲
            </button>
          )}
          <button style={subBtn} onClick={onBack}>
            ホームへ
          </button>
        </div>
      );
    }

    const targetCollapsed = collapseRepeats(targetMidis);
    const collapsedIdx = collapseIndices(targetMidis);
    const { text, showFirstNoteBtn } = resultMessage(selectedSong, collapsedIdx, evaluation!, truncatedWhileVoiced);
    const alignment: AlignmentEntry[] = evaluation!.alignment;

    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20 }}>{selectedSong.title}</h2>
        <p style={{ fontSize: 17 }}>{text}</p>
        {showFirstNoteBtn && (
          <button style={subBtn} onClick={() => void session.playTone(midiToHz(targetMidis[0]), L4_TONE_MS)}>
            🎵 最初の音をきく
          </button>
        )}
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888' }}>目標</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginTop: 4, paddingBottom: 4 }}>
            {alignment.map((e, i) => {
              const label = e.targetIndex !== null ? midiToSolfege(targetCollapsed[e.targetIndex]) : '・';
              const lyric = e.targetIndex !== null ? (selectedSong.notes[collapsedIdx[e.targetIndex]]?.lyric ?? '') : '';
              return (
                <div style={chip(e.kind === 'match')} key={`t${i}`}>
                  <div style={{ fontSize: 11, color: '#888' }}>{lyric || ' '}</div>
                  <div style={{ fontWeight: 700 }}>{label}</div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 12 }}>あなた</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginTop: 4, paddingBottom: 4 }}>
            {alignment.map((e, i) => (
              <div style={chip(e.kind === 'match')} key={`u${i}`}>
                <div style={{ fontWeight: 700 }}>{e.userMidi !== null ? midiToSolfege(e.userMidi) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
        {onComplete && (
          <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onComplete}>
            つぎのメニューへ
          </button>
        )}
        <button style={bigBtn} onClick={() => void runSongFlow(selectedSong)}>
          もう一回
        </button>
        {!onComplete && (
          <button style={{ ...bigBtn, background: '#1565c0' }} onClick={() => setPhase('songSelect')}>
            べつの曲
          </button>
        )}
        <button style={subBtn} onClick={onBack}>
          ホームへ
        </button>
      </div>
    );
  }

  return null;
}
