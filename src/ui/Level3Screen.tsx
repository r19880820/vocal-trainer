// Level 3「2音模倣」(高さ+幅の評価)本番UI。画面フロー・文言の正本は docs/UX_TRAINING.md §5d、
// 出題・判定仕様は docs/TRAINING_MODEL.md「Level 3: 2音模倣」。
// Level1Screen.tsx と同じ土台(録音→オフライン解析・👂/🎤合図・静音500ms連結・cancelledRefガード)。
// Level 1 との違い: 1セットN問ではなく**1問完結型**(結果画面→もう一回/つぎの問題/ホーム)。
// session は親(TrainingApp)から受け取り、このコンポーネント自身はマイクの生成/破棄(session.start以外)を
// 行わない(session.stop()の呼び出しは親の責務 — ライフサイクル管理を一箇所に集約する)。
import { useEffect, useRef, useState } from 'react';
import { AudioSession } from '../platform/audioSession';
import { runPipelineOffline } from '../core/offline';
import { evaluateLevel3, makeLevel3Trial, type Level3Evaluation, type Level3Trial } from '../core/exercise/level3';
import type { VoiceRange } from '../core/exercise/level2';
import { midiToHz } from '../core/pitch/conversions';
import { loadSettings, type Settings } from '../data/settings';
import { createProgressStore } from '../data/progressStore';
import {
  GUARD_AFTER_PLAYBACK_MS,
  L1_CAPTURE_MS,
  L1_TONE_GAP_MS,
  L1_TONE_MS,
  NOISE_MEASURE_MS,
  RANGE_MIN_COMFORT_BINS,
} from '../core/constants';

interface Props {
  session: AudioSession;
  /** 「← やめる/ホームへ」共通の離脱コールバック(ホームへ戻る)。 */
  onBack: () => void;
}

// localStorage を包むだけの薄いラッパーなのでモジュールスコープで1つ生成すれば十分(ADR-004。
// Level1Screen.tsx / TrainingApp.tsx のインスタンスとは別だが、同一 key を包むだけなので実質共有と等価)。
const progressStore = createProgressStore();

type Phase =
  | 'intro' // L3-1
  | 'preparing' // マイク起動中(過渡)
  | 'micDenied'
  | 'preSilence' // 静音500ms(ノイズ測定・録音して保持)
  | 'trial' // L3-2(出題1問)
  | 'result'; // L3-3

type TrialStage = 'tone' | 'sing' | 'judging' | 'feedback';

/** フィードバック表示の最小視認時間(UX_TRAINING.md §5c「1.5秒表示して自動で次へ」— L1と同じ値を
 * 測定不能時の再挑戦案内の表示にのみ使う。L3専用のUI都合値のためLevel1Screen.tsxと同様ここに
 * ローカル定義する — constants.tsに追記する指定はタスク仕様の定数一覧に含まれていない)。 */
const L3_FEEDBACK_DISPLAY_MS = 1500;

/** 音域チェック済みか(TrainingApp.tsx / Level1Screen.tsx の hasMeasuredRange と同条件。Level3Screenは
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

/** 出題方向の表示ラベル(Level1Screen.tsxのdirectionLabelと同型だが、Level 3にsame出題は無いため
 * up/downの2値のみ扱う — UIレイヤーの小さなヘルパーのため共有化せずここに複製する)。 */
function directionLabel(direction: 'up' | 'down'): string {
  return direction === 'up' ? '⤴ 上がる' : '⤵ 下がる';
}

/** L3-3結果画面のフィードバック文言(UX_TRAINING.md §5d L3-3が正本。優先順はTRAINING_MODEL.md「Level 3」)。 */
function feedbackText(evaluation: Level3Evaluation, trial: Level3Trial): string {
  const targetDirection: 'up' | 'down' = trial.bMidi > trial.aMidi ? 'up' : 'down';
  if (evaluation.feedback === 'direction') {
    return `まず2つ目の向きから。お手本は ${directionLabel(targetDirection)} でした`;
  }
  if (evaluation.feedback === 'interval') {
    const word = evaluation.offsetDirection === 'high' ? '高く' : '低く';
    return `向きはOK!2つ目をもう少し${word}すると幅がぴったりです`;
  }
  if (evaluation.feedback === 'offset') {
    const word = evaluation.offsetDirection === 'high' ? '高め' : '低め';
    return `音の幅はいいですね。全体をもう少し${word}にすると合います`;
  }
  return '2つともよく合っています!';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NO_EVAL: Level3Evaluation = {
  measured: false,
  firstNoteCents: null,
  secondNoteCents: null,
  userIntervalCents: null,
  intervalAccuracy: null,
  directionOk: null,
  feedback: null,
  offsetDirection: null,
};

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

export function Level3Screen({ session, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [trialStage, setTrialStage] = useState<TrialStage>('tone');
  const [toneCount, setToneCount] = useState<1 | 2>(1);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [currentTrial, setCurrentTrial] = useState<Level3Trial | null>(null);
  const [evaluation, setEvaluation] = useState<Level3Evaluation | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 開始直後に録音した静音PCM(ノイズフロア推定用)。各問の解析でこの先頭へ連結する(Level1Screenと同じ作法)。
  const silenceRef = useRef<{ sampleRate: number; pcm: Float32Array } | null>(null);
  // アンマウント後にawait継続分がstateを書き換えないためのガード(session.stop()は親の責務)。
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

  /** 1問分(A再生→間→B再生→ガード→捕捉→解析)を実行し評価結果を返す。 */
  const captureTrial = async (trial: Level3Trial): Promise<Level3Evaluation> => {
    // ♪1つ目/♪2つ目の表示はLevel 1と同一様式(UX_TRAINING.md §5d L3-2)。
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

    // 静音PCMを先頭へ連結してから解析(runPipelineOfflineのノイズフロア推定窓のため必須。Level1Screenと同じ作法)。
    const combined = new Float32Array(silence.pcm.length + rec.pcm.length);
    combined.set(silence.pcm, 0);
    combined.set(rec.pcm, silence.pcm.length);
    const { processed } = runPipelineOffline(combined, rec.sampleRate);

    // 静音分(先頭)を除いた捕捉区間だけを判定に使う。
    const silenceMs = (silence.pcm.length / rec.sampleRate) * 1000;
    const trialProcessed = processed.filter((p) => p.timestampMs >= silenceMs);
    return evaluateLevel3(trialProcessed, trial);
  };

  /**
   * 1問を実行する(L3-1「はじめる」/ L3-3「もう一回」「つぎの問題」から呼ばれる)。
   * fixedTrial を渡せば同じ問題を再挑戦、省略すれば新しい出題を生成する。
   * Level1Screenの「もう一回」(runSet再実行)と同じ粒度で、毎回 preSilence(静音500ms)を録り直す。
   */
  const runTrial = async (fixedTrial?: Level3Trial) => {
    setErrorMsg(null);
    setEvaluation(null);

    if (!session.running) {
      setPhase('preparing');
      try {
        await session.start(
          () => {
            // L3はライブピッチ表示をしない(捕捉窓終了後にオフライン解析する方式のため不要)。
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
      // 静音録音に失敗(仕様未定義の異常系 — Level1Screenと同じ実装判断。詳細は最終報告)。
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

    const trial = fixedTrial ?? makeLevel3Trial(comfortRange, range);
    setCurrentTrial(trial);
    setPhase('trial');
    setFeedbackMsg(null);

    let result = await captureTrial(trial);
    if (cancelledRef.current) return;

    if (!result.measured) {
      // 測定不能: Level 1 と同じ文言で1回だけ再挑戦(UX_TRAINING.md §5d L3-3「測定不能」)。
      setTrialStage('feedback');
      setFeedbackMsg('もう少し長めに「んー、んー」と歌ってみてください。もう一度どうぞ');
      await sleep(L3_FEEDBACK_DISPLAY_MS);
      if (cancelledRef.current) return;

      result = await captureTrial(trial);
      if (cancelledRef.current) return;
    }

    // measured=falseの回は保存しない(タスク仕様)。
    if (result.measured && result.intervalAccuracy !== null && result.directionOk !== null) {
      const exerciseId = `level3-${Date.now()}`;
      progressStore.appendSnapshot('intervalAccuracy', result.intervalAccuracy, exerciseId);
      progressStore.appendSnapshot('directionAccuracy', result.directionOk ? 1 : 0, exerciseId);
    }

    setEvaluation(result);
    setPhase('result');
  };

  // ---- L3-1 説明 ----
  if (phase === 'intro') {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>2音まねっこ</h2>
        <p>2つの音が鳴ります。同じ高さで「んー、んー」と真似してください(つなげて「んーんー」でも大丈夫)。</p>
        <p>今度は向きだけでなく、音の高さと幅も見ます</p>
        {errorMsg && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#888' }}>{errorMsg}</p>
          </div>
        )}
        <button style={bigBtn} onClick={() => void runTrial()}>
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
        <p style={{ textAlign: 'center', marginTop: 80 }}>準備中…</p>
      </div>
    );
  }

  // ---- マイク許可なし ----
  if (phase === 'micDenied') {
    return (
      <div style={page}>
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
        <p style={{ textAlign: 'center', fontSize: 18, marginTop: 80 }}>そのまま静かに…</p>
        <button style={{ ...subBtn, marginTop: 60 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- L3-2 出題 ----
  if (phase === 'trial') {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20, textAlign: 'center' }}>2音まねっこ</h2>
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
        {trialStage === 'feedback' && feedbackMsg && (
          <div style={card}>
            <p style={{ fontSize: 17, fontWeight: 700, textAlign: 'center' }}>{feedbackMsg}</p>
          </div>
        )}
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- L3-3 結果 ----
  if (phase === 'result') {
    const measured = evaluation !== null && evaluation.measured && currentTrial !== null;
    return (
      <div style={page}>
        {measured && evaluation && currentTrial ? (
          <>
            <h2 style={{ fontSize: 20 }}>2音まねっこ</h2>
            <p style={{ fontSize: 17 }}>{feedbackText(evaluation, currentTrial)}</p>
          </>
        ) : (
          // 1回の自動再挑戦後も測定できなかった場合(仕様未定義の異常系)。Level1Screenの
          // 「有効問題が1問も取れなかった」フォールバック文言を再利用する実装判断(詳細は最終報告)。
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
        <button style={bigBtn} onClick={() => void runTrial(currentTrial ?? undefined)}>
          もう一回
        </button>
        <button style={{ ...bigBtn, background: '#1565c0' }} onClick={() => void runTrial()}>
          つぎの問題
        </button>
        <button style={subBtn} onClick={onBack}>
          ホームへ
        </button>
      </div>
    );
  }

  return null;
}
