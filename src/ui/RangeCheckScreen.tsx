// 音域チェック(Range Check)v2「音についていく方式」画面。フロー・文言の正本は
// docs/UX_TRAINING.md §5b、解析仕様は docs/TRAINING_MODEL.md「音域チェック(Range Check)」。
// ExerciseEngineとは独立(TRAINING_MODEL.md)。session は親(TrainingApp)から受け取り、
// このコンポーネント自身はマイクの生成/破棄(session.start以外)を行わない
// (session.stop()の呼び出しは親の責務 — ライフサイクル管理を一箇所に集約する)。
import { useEffect, useRef, useState } from 'react';
import { AudioSession } from '../platform/audioSession';
import { runPipelineOffline } from '../core/offline';
import { aggregateSteps, evaluateStep, type RangeStepsResult, type StepEvaluation } from '../core/range/steps';
import { midiToHz } from '../core/pitch/conversions';
import { midiToSolfege, nextCMajorAbove, nextCMajorBelow } from '../core/pitch/scale';
import { loadSettings, saveSettings, type Settings } from '../data/settings';
import {
  GUARD_AFTER_PLAYBACK_MS,
  NOISE_MEASURE_MS,
  RANGE_MAX_STEPS,
  RANGE_STEP_CAPTURE_MS,
  RANGE_STEP_MIN_VOICED_MS,
  RANGE_STEP_TONE_MS,
} from '../core/constants';

interface Props {
  session: AudioSession;
  /** 測定成功のたびに呼ばれる(=settingsが保存された通知)。画面遷移はしない — 遷移は onBack が担う。 */
  onDone: (settings: Settings) => void;
  /** 「もどる/やめる/ホームへ」共通の離脱コールバック(ホームへ戻る)。 */
  onBack: () => void;
}

type Phase =
  | 'intro' // RC-1
  | 'preparing' // マイク起動中(過渡)
  | 'micDenied'
  | 'preSilence' // 静音500ms(ノイズ測定・録音して保持)
  | 'measuringDown' // RC-2 下降パス
  | 'measuringUp' // RC-2 上昇パス
  | 'result' // RC-3 成功
  | 'failed'; // RC-3 失敗

/** 開始音(声域設定 低め=ソ3 / 高め=ド4。TRAINING_MODEL.md「音域チェック」)。 */
const START_MIDI_LOW = 55; // ソ3
const START_MIDI_HIGH = 60; // ド4

/** ✓表示の最小視認時間(仕様に明記なし — 実装判断。core/constants.tsのRANGE_*ブロックは
 * 「追加してよい定数」が仕様書で列挙済みのため、UI専用のこの値はここにローカル定義する)。 */
const STEP_SUCCESS_FLASH_MS = 300;

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

/** 実数MIDI→標準MIDIオクターブ番号(60=C4)。 */
function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** ドレミ表記+オクターブ番号(RC-2「ソ3」/ RC-3結果表示専用。他画面はオクターブ非表示のmidiToSolfegeをそのまま使う)。 */
function noteLabel(midi: number | null): string {
  if (midi === null) return '';
  return `${midiToSolfege(midi)}${octaveOf(midi)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StepRecord = { targetMidi: number; eval: StepEvaluation };

export function RangeCheckScreen({ session, onDone, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [stepNoteText, setStepNoteText] = useState('');
  const [stepSuccess, setStepSuccess] = useState(false);
  // 「いつ歌えばいいか」の合図(2026-08-16 v2初回実測で全滅事故: お手本と一緒に歌って
  // 捕捉窓が無音になるユーザーが必然 — 合図なしでは after-tone 方式は成立しない)
  const [stepStage, setStepStage] = useState<'tone' | 'sing' | 'judging'>('tone');
  const [result, setResult] = useState<RangeStepsResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 開始直後に録音した静音PCM(ノイズフロア推定用)。各ステップの解析でこの先頭へ連結する。
  const silenceRef = useRef<{ sampleRate: number; pcm: Float32Array } | null>(null);
  // アンマウント後にawait継続分がstateを書き換えないためのガード(session.stop()は親の責務なので
  // ここではタイマーの後始末のみ管理する)。
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

  /** 1ステップ分(お手本再生→ガード→捕捉→解析)を実行し判定結果を返す。 */
  const captureStep = async (targetMidi: number): Promise<StepEvaluation> => {
    const unmatched: StepEvaluation = { matched: false, comfortable: false, medianCents: null, voicedMs: 0 };

    setStepStage('tone');
    await session.playTone(midiToHz(targetMidi), RANGE_STEP_TONE_MS);
    if (cancelledRef.current) return unmatched;

    await sleep(GUARD_AFTER_PLAYBACK_MS);
    if (cancelledRef.current) return unmatched;

    setStepStage('sing');
    session.setRecording(true);
    await sleep(RANGE_STEP_CAPTURE_MS);
    session.setRecording(false);
    setStepStage('judging');
    if (cancelledRef.current) return unmatched;

    const rec = session.getRecording();
    const silence = silenceRef.current;
    if (!rec || !silence) return unmatched;

    // 静音PCMを先頭へ連結してから解析(runPipelineOfflineのノイズフロア推定窓のため必須)。
    const combined = new Float32Array(silence.pcm.length + rec.pcm.length);
    combined.set(silence.pcm, 0);
    combined.set(rec.pcm, silence.pcm.length);
    const { processed } = runPipelineOffline(combined, rec.sampleRate);

    // 静音分(先頭)を除いた捕捉区間だけを判定に使う。
    const silenceMs = (silence.pcm.length / rec.sampleRate) * 1000;
    const stepProcessed = processed.filter((p) => p.timestampMs >= silenceMs);
    return evaluateStep(stepProcessed, targetMidi);
  };

  /**
   * 1パス(下降または上昇)を実行する。matched → 次のスケール音へ、unmatched または
   * RANGE_MAX_STEPS到達で終了。reuseFirst が渡された場合、開始音の評価はやり直さず
   * それを1ステップ目として使う(上昇パスが下降パスの開始音評価を再利用するため)。
   */
  const runPass = async (
    direction: 'down' | 'up',
    startMidi: number,
    reuseFirst?: StepEvaluation
  ): Promise<StepRecord[]> => {
    const results: StepRecord[] = [];
    let target = startMidi;
    for (let i = 0; i < RANGE_MAX_STEPS; i++) {
      if (cancelledRef.current) break;

      let evaluation: StepEvaluation;
      if (i === 0 && reuseFirst) {
        evaluation = reuseFirst;
      } else {
        setStepNoteText(noteLabel(target));
        setStepSuccess(false);
        evaluation = await captureStep(target);
        if (cancelledRef.current) break;
        // 声が捕捉窓にほぼ入らなかった(タイミングのすれ違い)場合のみ、同じ音を1回だけやり直す。
        // 声は出ていたが高さが合わなかった場合は本当の限界なのでやり直さない(2026-08-16 全滅事故対策)。
        if (!evaluation.matched && evaluation.voicedMs < RANGE_STEP_MIN_VOICED_MS) {
          evaluation = await captureStep(target);
          if (cancelledRef.current) break;
        }
      }

      results.push({ targetMidi: target, eval: evaluation });
      setStepSuccess(evaluation.matched);

      if (!evaluation.matched) break;
      if (i === RANGE_MAX_STEPS - 1) break;

      await sleep(STEP_SUCCESS_FLASH_MS);
      if (cancelledRef.current) break;

      target = direction === 'down' ? nextCMajorBelow(target) : nextCMajorAbove(target);
    }
    return results;
  };

  const runMeasurement = async () => {
    setErrorMsg(null);
    setResult(null);

    if (!session.running) {
      setPhase('preparing');
      try {
        await session.start(
          () => {
            // v2はライブピッチ表示をしない(お手本の目標音を表示する方式のため不要)。
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
      setPhase('failed');
      return;
    }
    silenceRef.current = silence;

    try {
      const startMidi = loadSettings().range === 'high' ? START_MIDI_HIGH : START_MIDI_LOW;

      setPhase('measuringDown');
      const downSteps = await runPass('down', startMidi);
      if (cancelledRef.current) return;

      setPhase('measuringUp');
      // 開始音の再利用は matched だった場合のみ。失敗判定を使い回すと、下降1音目の
      // すれ違いだけで上昇パスまで即終了してしまう(2026-08-16 全滅事故の一因)
      const reuseFirst = downSteps[0]?.eval.matched ? downSteps[0].eval : undefined;
      const upSteps = await runPass('up', startMidi, reuseFirst);
      if (cancelledRef.current) return;

      // reuseFirst を使った場合のみ upSteps[0] は downSteps[0] の複製なので除外する
      // (再利用しなかった場合の upSteps[0] は開始音の再挑戦=本物の評価なので落とさない)。
      const allSteps = reuseFirst ? [...downSteps, ...upSteps.slice(1)] : [...downSteps, ...upSteps];
      const aggregated = aggregateSteps(allSteps);

      if (!aggregated.ok) {
        setPhase('failed');
        return;
      }

      const next: Settings = {
        ...loadSettings(),
        rangeComfortLowMidi: aggregated.comfortLowMidi,
        rangeComfortHighMidi: aggregated.comfortHighMidi,
        rangeFullLowMidi: aggregated.fullLowMidi,
        rangeFullHighMidi: aggregated.fullHighMidi,
        rangeMeasuredAt: new Date().toISOString(),
      };
      saveSettings(next);
      onDone(next);
      setResult(aggregated);
      setPhase('result');
    } catch (e) {
      if (cancelledRef.current) return;
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  };

  // ---- RC-1 説明 ----
  if (phase === 'intro') {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>音域をはかる</h2>
        <p>
          あなたの声の範囲をはかります。鳴ったお手本の音に、同じ高さで「んー」とついてきてください(合わせて15秒くらい)
        </p>
        <p style={{ fontSize: 13, color: '#888' }}>
          まわりが静かな場所で行うと、正確にはかれます。イヤホンは無くても大丈夫です
        </p>
        {errorMsg && (
          <div style={card}>
            <p style={{ fontSize: 13, color: '#888' }}>{errorMsg}</p>
          </div>
        )}
        <button style={bigBtn} onClick={() => void runMeasurement()}>
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
          <p>マイクが使えないと音域をはかれません。ブラウザの設定からマイクを許可してください。</p>
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

  // ---- RC-2 測定(下降/上昇。「音についていく方式」) ----
  if (phase === 'measuringDown' || phase === 'measuringUp') {
    const directionText = phase === 'measuringDown' ? '下がって' : '上がって';
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20, textAlign: 'center' }}>お手本についてきてください</h2>
        <p style={{ textAlign: 'center', fontSize: 15 }}>
          お手本が<b>鳴りおわったら</b>、同じ高さで「んー」。お手本は1音ずつ{directionText}いきます
        </p>
        <div style={{ textAlign: 'center', fontSize: 48, fontWeight: 700, marginTop: 24, minHeight: 60 }}>
          {stepNoteText}
          {stepSuccess && <span style={{ color: '#2e7d32', fontSize: 28, marginLeft: 10 }}>✓</span>}
        </div>
        <p
          style={{
            textAlign: 'center',
            fontSize: 22,
            fontWeight: 700,
            minHeight: 32,
            marginTop: 8,
            color: stepStage === 'sing' ? '#2e7d32' : '#777',
          }}
        >
          {stepStage === 'tone' ? '👂 聞いて…' : stepStage === 'sing' ? '🎤 いま!「んー」' : '…'}
        </p>
        <p style={{ textAlign: 'center', fontSize: 13, color: '#888', marginTop: 16 }}>
          出しにくくなったら止まって大丈夫。そこまでが今の範囲です
        </p>
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- RC-3 失敗 ----
  if (phase === 'failed') {
    return (
      <div style={page}>
        <div style={card}>
          <p>
            うまく測れませんでした。お手本が<b>鳴りおわってから</b>、「🎤 いま!」の合図に合わせて「んー」と声を出してみてください
          </p>
        </div>
        <button style={bigBtn} onClick={() => void runMeasurement()}>
          もう一度
        </button>
        <button style={subBtn} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- RC-3 成功 ----
  if (phase === 'result' && result) {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>あなたの声の範囲がわかりました</h2>
        <div style={card}>
          <div style={{ fontSize: 15 }}>
            楽に出せる範囲: <b>{noteLabel(result.comfortLowMidi)} 〜 {noteLabel(result.comfortHighMidi)}</b>
          </div>
          <div style={{ fontSize: 15, marginTop: 8 }}>
            がんばれば: <b>{noteLabel(result.fullLowMidi)} 〜 {noteLabel(result.fullHighMidi)}</b>
          </div>
        </div>
        <p style={{ fontSize: 13, color: '#888', marginTop: 12 }}>
          これからのお手本は「楽に出せる範囲」から選びます
        </p>
        <button style={bigBtn} onClick={onBack}>
          ホームへ
        </button>
      </div>
    );
  }

  return null;
}
