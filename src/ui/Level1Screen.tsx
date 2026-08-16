// Level 1「音の上下」(相対音感ドリル)本番UI。画面フロー・文言の正本は docs/UX_TRAINING.md §5c、
// 出題・判定仕様は docs/TRAINING_MODEL.md「Level 1: 音の上下」。
// RangeCheckScreen.tsx と同じ土台(録音→オフライン解析・👂/🎤合図・静音500ms連結・cancelledRefガード)。
// session は親(TrainingApp)から受け取り、このコンポーネント自身はマイクの生成/破棄(session.start以外)を
// 行わない(session.stop()の呼び出しは親の責務 — ライフサイクル管理を一箇所に集約する)。
import { useEffect, useRef, useState } from 'react';
import { AudioSession } from '../platform/audioSession';
import { runPipelineOffline } from '../core/offline';
import {
  evaluateDirection,
  makeLevel1Trial,
  type Direction,
  type DirectionEvaluation,
  type Level1Trial,
} from '../core/exercise/level1';
import type { VoiceRange } from '../core/exercise/level2';
import { midiToHz } from '../core/pitch/conversions';
import { loadSettings, type Settings } from '../data/settings';
import { createProgressStore } from '../data/progressStore';
import {
  GUARD_AFTER_PLAYBACK_MS,
  L1_CAPTURE_MS,
  L1_TONE_GAP_MS,
  L1_TONE_MS,
  L1_TRIALS,
  NOISE_MEASURE_MS,
  RANGE_MIN_COMFORT_BINS,
} from '../core/constants';

interface Props {
  session: AudioSession;
  /** 「← やめる/ホームへ」共通の離脱コールバック(ホームへ戻る)。 */
  onBack: () => void;
  /** 「今日のメニュー」実行中(TrainingApp)から渡される進捗ラベル(例: 「メニュー 2/4」)。
   * あれば画面上部に小さく表示する(UX_TRAINING.md §5e M-2)。単独起動時は省略され非表示。 */
  menuLabel?: string;
  /** 「今日のメニュー」実行中のみ渡される。あればL1-3結果画面の主ボタンが[つぎのメニューへ]になり、
   * タップでこれを呼ぶ(もう一回は残す)。単独起動時(props省略)は従来どおり[もう一回][ホームへ]のまま。 */
  onComplete?: () => void;
}

// localStorage を包むだけの薄いラッパーなのでモジュールスコープで1つ生成すれば十分(ADR-004。
// TrainingApp.tsx のインスタンスとは別だが、同一 key('vt.progress.v1')を包むだけなので実質共有と等価)。
const progressStore = createProgressStore();

type Phase =
  | 'intro' // L1-1
  | 'preparing' // マイク起動中(過渡)
  | 'micDenied'
  | 'preSilence' // 静音500ms(ノイズ測定・録音して保持)
  | 'trial' // L1-2(出題×L1_TRIALS問)
  | 'result'; // L1-3

type TrialStage = 'tone' | 'sing' | 'judging' | 'feedback';

interface TrialFeedback {
  kind: 'correct' | 'incorrect' | 'measureFail';
  text: string;
}

interface SetResult {
  validCount: number;
  correctCount: number;
}

/** フィードバック表示の最小視認時間(UX_TRAINING.md §5c「1.5秒表示して自動で次へ」)。
 * L1専用のUI都合値のため、RANGE_*同様ここにローカル定義する(constants.tsに追記する指定は
 * タスク仕様の定数一覧に含まれていない)。 */
const L1_FEEDBACK_DISPLAY_MS = 1500;

/** 音域チェック済みか(TrainingApp.tsx の hasMeasuredRange と同条件。Level1Screenは
 * props を {session, onBack} に固定する指定のため、共有ヘルパー化はせずここに複製する
 * — 詳細は最終報告)。 */
function hasMeasuredRange(
  s: Settings
): s is Settings & { rangeComfortLowMidi: number; rangeComfortHighMidi: number } {
  return (
    s.rangeComfortLowMidi !== null &&
    s.rangeComfortHighMidi !== null &&
    s.rangeComfortHighMidi - s.rangeComfortLowMidi + 1 >= RANGE_MIN_COMFORT_BINS
  );
}

function directionLabel(direction: Direction): string {
  if (direction === 'up') return '⤴ 上がる';
  if (direction === 'down') return '⤵ 下がる';
  return '→ おなじ高さ';
}

function encouragement(correctCount: number, validCount: number): string {
  if (correctCount === validCount) return 'すばらしい!全部聞き分けられました';
  if (correctCount > validCount / 2) return 'いい調子です。この練習は耳と声のつながりを育てます';
  return '上下の聞き分けはこれから伸びるところです。ゆっくり続けましょう';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NO_EVAL: DirectionEvaluation = { detected: null, deltaCents: null, segments: 0 };

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

/** menuLabelがあれば画面上部に小さく表示する共通スニペット(UX_TRAINING.md §5e M-2)。全phaseで統一表示する。 */
function MenuLabel({ menuLabel }: { menuLabel: string | undefined }) {
  if (!menuLabel) return null;
  return <p style={{ textAlign: 'center', fontSize: 12, color: '#aaa' }}>{menuLabel}</p>;
}

export function Level1Screen({ session, onBack, menuLabel, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [trialStage, setTrialStage] = useState<TrialStage>('tone');
  const [toneCount, setToneCount] = useState<1 | 2>(1);
  const [trialNumber, setTrialNumber] = useState(1);
  const [feedback, setFeedback] = useState<TrialFeedback | null>(null);
  const [setResult, setSetResult] = useState<SetResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 開始直後に録音した静音PCM(ノイズフロア推定用)。各問の解析でこの先頭へ連結する(RangeCheckScreenと同じ作法)。
  const silenceRef = useRef<{ sampleRate: number; pcm: Float32Array } | null>(null);
  // アンマウント後にawait継続分がstateを書き換えないためのガード(session.stop()は親の責務)。
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

  /** 1問分(A再生→間→B再生→ガード→捕捉→解析)を実行し方向判定結果を返す。 */
  const captureTrial = async (trial: Level1Trial): Promise<DirectionEvaluation> => {
    // ♪1つ目/♪2つ目の表示: 同一音の出題(same)では2音が1回に聞こえるため、
    // 目でも「2音鳴った」ことを確認できるようにする(2026-08-16 ユーザー報告対応)
    setTrialStage('tone');
    setToneCount(1);
    await session.playTone(midiToHz(trial.aMidi), L1_TONE_MS);
    if (cancelledRef.current) return NO_EVAL;

    await sleep(L1_TONE_GAP_MS);
    if (cancelledRef.current) return NO_EVAL;

    setToneCount(2);
    await session.playTone(midiToHz(trial.bMidi), L1_TONE_MS);
    if (cancelledRef.current) return NO_EVAL;

    await sleep(GUARD_AFTER_PLAYBACK_MS);
    if (cancelledRef.current) return NO_EVAL;

    setTrialStage('sing');
    session.setRecording(true);
    await sleep(L1_CAPTURE_MS);
    session.setRecording(false);
    setTrialStage('judging');
    if (cancelledRef.current) return NO_EVAL;

    const rec = session.getRecording();
    const silence = silenceRef.current;
    if (!rec || !silence) return NO_EVAL;

    // 静音PCMを先頭へ連結してから解析(runPipelineOfflineのノイズフロア推定窓のため必須。RangeCheckScreenと同じ作法)。
    const combined = new Float32Array(silence.pcm.length + rec.pcm.length);
    combined.set(silence.pcm, 0);
    combined.set(rec.pcm, silence.pcm.length);
    const { processed } = runPipelineOffline(combined, rec.sampleRate);

    // 静音分(先頭)を除いた捕捉区間だけを判定に使う。
    const silenceMs = (silence.pcm.length / rec.sampleRate) * 1000;
    const trialProcessed = processed.filter((p) => p.timestampMs >= silenceMs);
    return evaluateDirection(trialProcessed);
  };

  const runSet = async () => {
    setErrorMsg(null);
    setSetResult(null);

    if (!session.running) {
      setPhase('preparing');
      try {
        await session.start(
          () => {
            // L1はライブピッチ表示をしない(捕捉窓終了後にオフライン解析する方式のため不要)。
          },
          (m) => setErrorMsg(m)
        );
      } catch (e) {
        if (cancelledRef.current) return;
        setPhase('micDenied');
        setErrorMsg(e instanceof Error ? e.message : String(e));
        return;
      }
      if (cancelledRef.current) return;
    }

    setPhase('preSilence');
    session.setRecording(true);
    await sleep(NOISE_MEASURE_MS);
    session.setRecording(false);
    if (cancelledRef.current) return;

    const silence = session.getRecording();
    if (!silence) {
      // 静音録音に失敗(仕様未定義の異常系 — RangeCheckScreenのfailed画面に相当するものがL1には
      // 無いため、introへ戻してエラーを添える実装判断。詳細は最終報告)。
      setPhase('intro');
      setErrorMsg('うまく準備できませんでした。もう一度お試しください');
      return;
    }
    silenceRef.current = silence;

    const settings = loadSettings();
    const comfortRange = hasMeasuredRange(settings)
      ? { lowMidi: settings.rangeComfortLowMidi, highMidi: settings.rangeComfortHighMidi }
      : null;
    const range: VoiceRange = settings.range ?? 'low';

    let correctCount = 0;
    let validCount = 0;

    for (let i = 0; i < L1_TRIALS; i++) {
      if (cancelledRef.current) return;
      setTrialNumber(i + 1);
      setPhase('trial');
      setFeedback(null);

      const trial = makeLevel1Trial(comfortRange, range);
      let evaluation = await captureTrial(trial);
      if (cancelledRef.current) return;

      if (evaluation.detected === null) {
        setTrialStage('feedback');
        setFeedback({
          kind: 'measureFail',
          text: 'もう少し長めに「んー、んー」と歌ってみてください。もう一度どうぞ',
        });
        await sleep(L1_FEEDBACK_DISPLAY_MS);
        if (cancelledRef.current) return;

        // 同じ問題を1回だけ再挑戦(TRAINING_MODEL.md「ユーザー発声の分割」)。
        evaluation = await captureTrial(trial);
        if (cancelledRef.current) return;

        if (evaluation.detected === null) {
          // それでも不能なら有効問題数から除外して次へ(責めない — UX_TRAINING.md §5c)。
          setTrialStage('feedback');
          setFeedback({
            kind: 'measureFail',
            text: 'もう少し長めに「んー、んー」と歌ってみてください。もう一度どうぞ',
          });
          await sleep(L1_FEEDBACK_DISPLAY_MS);
          if (cancelledRef.current) return;
          continue;
        }
      }

      validCount += 1;
      const correct = evaluation.detected === trial.direction;
      if (correct) correctCount += 1;
      setTrialStage('feedback');
      setFeedback(
        correct
          ? { kind: 'correct', text: `そのとおり! ${directionLabel(trial.direction)}` }
          : { kind: 'incorrect', text: `お手本は ${directionLabel(trial.direction)} でした` }
      );
      await sleep(L1_FEEDBACK_DISPLAY_MS);
      if (cancelledRef.current) return;
    }

    // 有効数0なら保存しない(TRAINING_MODEL.md「Level 1」セット結果)。
    if (validCount > 0) {
      progressStore.appendSnapshot('directionAccuracy', correctCount / validCount, `level1-${Date.now()}`);
    }
    setSetResult({ validCount, correctCount });
    setPhase('result');
  };

  // ---- L1-1 説明 ----
  if (phase === 'intro') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20 }}>音の上下</h2>
        <p>2つの音が鳴ります。同じように「んー、んー」と真似してください(つなげて「んーんー」でも大丈夫)。</p>
        <p>大事なのは高さピッタリではなく、2つ目の音が「上がるか・下がるか」です</p>
        {errorMsg && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#888' }}>{errorMsg}</p>
          </div>
        )}
        <button style={bigBtn} onClick={() => void runSet()}>
          はじめる
        </button>
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

  // ---- L1-2 出題 ----
  if (phase === 'trial') {
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        <h2 style={{ fontSize: 20, textAlign: 'center' }}>音の上下</h2>
        <p style={{ textAlign: 'center', fontSize: 13, color: '#888' }}>
          {trialNumber}問目 / {L1_TRIALS}
        </p>
        <p
          style={{
            textAlign: 'center',
            fontSize: 22,
            fontWeight: 700,
            minHeight: 32,
            marginTop: 40,
            color: trialStage === 'sing' ? '#2e7d32' : '#777',
          }}
        >
          {trialStage === 'tone'
            ? `👂 聞いて… ♪${toneCount}つ目`
            : trialStage === 'sing'
              ? '🎤 いま!「んー、んー」'
              : trialStage === 'judging'
                ? '…'
                : ''}
        </p>
        {trialStage === 'feedback' && feedback && (
          <div style={card}>
            <p style={{ fontSize: 17, fontWeight: 700, textAlign: 'center' }}>{feedback.text}</p>
          </div>
        )}
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- L1-3 セット結果 ----
  if (phase === 'result' && setResult) {
    const { validCount, correctCount } = setResult;
    return (
      <div style={page}>
        <MenuLabel menuLabel={menuLabel} />
        {validCount > 0 ? (
          <>
            <h2 style={{ fontSize: 20 }}>
              {validCount}回中 {correctCount}回、聞き分けられました
            </h2>
            <p>{encouragement(correctCount, validCount)}</p>
          </>
        ) : (
          // 有効問題が1問も取れなかった場合(仕様未定義の異常系)。UX_TRAINING.md §3.5の
          // 汎用測定不能文言を再利用する実装判断(詳細は最終報告)。
          <div style={card}>
            <p>
              声をうまく聞き取れませんでした。
              <br />
              次は「声の届け方」を意識してみましょう
              <br />
              マイクの近くで、はっきり・長めに「んー」と声を出してみましょう
            </p>
          </div>
        )}
        {onComplete && (
          // メニュー中の主ボタン(UX_TRAINING.md §5e M-2)。もう一回は残す(タスク仕様)。
          <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onComplete}>
            つぎのメニューへ
          </button>
        )}
        <button style={bigBtn} onClick={() => void runSet()}>
          もう一回
        </button>
        <button style={subBtn} onClick={onBack}>
          ホームへ
        </button>
      </div>
    );
  }

  return null;
}
