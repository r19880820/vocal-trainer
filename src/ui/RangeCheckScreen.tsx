// 音域チェック(Range Check)画面。フロー・文言の正本は docs/UX_TRAINING.md §5b、
// 解析仕様は docs/TRAINING_MODEL.md「音域チェック(Range Check)」。
// ExerciseEngineとは独立(TRAINING_MODEL.md)。session は親(TrainingApp)から受け取り、
// このコンポーネント自身はマイクの生成/破棄(session.start以外)を行わない
// (session.stop()の呼び出しは親の責務 — ライフサイクル管理を一箇所に集約する)。
import { useEffect, useRef, useState } from 'react';
import { AudioSession } from '../platform/audioSession';
import { runPipelineOffline } from '../core/offline';
import { analyzeVocalRange, type VocalRangeResult } from '../core/range/analyzeRange';
import { hzToMidi } from '../core/pitch/conversions';
import { midiToSolfege } from '../core/pitch/scale';
import { loadSettings, saveSettings, type Settings } from '../data/settings';
import { NOISE_MEASURE_MS, RANGE_PASS_SECONDS } from '../core/constants';
import type { RawPitchSample } from '../core/types';

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
  | 'preSilence' // 静音500ms(ノイズ測定)
  | 'measuringDown' // RC-2 下降パス
  | 'measuringUp' // RC-2 上昇パス
  | 'analyzing' // 判定中(過渡)
  | 'result' // RC-3 成功
  | 'failed'; // RC-3 失敗

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

/** ドレミ表記+オクターブ番号(RC-2「いま: ソ3」/ RC-3結果表示専用。他画面はオクターブ非表示のmidiToSolfegeをそのまま使う)。 */
function noteLabel(midi: number | null): string {
  if (midi === null) return '';
  return `${midiToSolfege(midi)}${octaveOf(midi)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** durationMs間、100ms刻みでonTick(残りms)を呼びながら待つ(RC-2のカウントダウン表示用)。 */
function countdown(durationMs: number, onTick: (remainingMs: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    onTick(durationMs);
    const id = window.setInterval(() => {
      const remaining = Math.max(0, durationMs - (performance.now() - startedAt));
      onTick(remaining);
      if (remaining <= 0) {
        window.clearInterval(id);
        resolve();
      }
    }, 100);
  });
}

export function RangeCheckScreen({ session, onDone, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [remainingMs, setRemainingMs] = useState(RANGE_PASS_SECONDS * 1000);
  const [noteText, setNoteText] = useState('');
  const [result, setResult] = useState<VocalRangeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const latestRawRef = useRef<RawPitchSample | null>(null);
  // アンマウント後にawait継続分がstateを書き換えないためのガード(session.stop()は親の責務なので
  // ここではタイマーの後始末のみ管理する)。
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

  // 「いま: ソ3」表示(RC-2)。onPitchは高頻度(約86Hz)なのでrefで受け、100msごとにstateへ反映する
  // (DebugPageの実機読み戻し表示と同じ間引き方式)。
  useEffect(() => {
    if (phase !== 'measuringDown' && phase !== 'measuringUp') return;
    const id = window.setInterval(() => {
      const s = latestRawRef.current;
      if (s && s.frequencyHz > 0 && s.belowThreshold) {
        setNoteText(noteLabel(hzToMidi(s.frequencyHz)));
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [phase]);

  const runMeasurement = async () => {
    setErrorMsg(null);
    setResult(null);

    if (!session.running) {
      setPhase('preparing');
      try {
        await session.start(
          (s) => {
            latestRawRef.current = s;
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
    await sleep(NOISE_MEASURE_MS);
    if (cancelledRef.current) return;

    setNoteText('');
    setPhase('measuringDown');
    session.setRecording(true);
    await countdown(RANGE_PASS_SECONDS * 1000, setRemainingMs);
    session.setRecording(false);
    const down = session.getRecording();
    if (cancelledRef.current) return;

    setNoteText('');
    setPhase('measuringUp');
    session.setRecording(true);
    await countdown(RANGE_PASS_SECONDS * 1000, setRemainingMs);
    session.setRecording(false);
    const up = session.getRecording();
    if (cancelledRef.current) return;

    setPhase('analyzing');
    setNoteText('');

    if (!down || !up) {
      if (!cancelledRef.current) setPhase('failed');
      return;
    }

    try {
      const a = runPipelineOffline(down.pcm, down.sampleRate);
      const b = runPipelineOffline(up.pcm, up.sampleRate);
      const analyzed = analyzeVocalRange([...a.raw, ...b.raw], [...a.processed, ...b.processed]);
      if (cancelledRef.current) return;

      if (!analyzed.ok) {
        setPhase('failed');
        return;
      }

      const next: Settings = {
        ...loadSettings(),
        rangeComfortLowMidi: analyzed.comfortLowMidi,
        rangeComfortHighMidi: analyzed.comfortHighMidi,
        rangeFullLowMidi: analyzed.fullLowMidi,
        rangeFullHighMidi: analyzed.fullHighMidi,
        rangeMeasuredAt: new Date().toISOString(),
      };
      saveSettings(next);
      onDone(next);
      setResult(analyzed);
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
          あなたの声の範囲をはかります。「んー」で、低い方と高い方へゆっくりスライドします(合わせて15秒くらい)
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

  // ---- RC-2 測定(下降/上昇) ----
  if (phase === 'measuringDown' || phase === 'measuringUp') {
    const seconds = Math.ceil(remainingMs / 1000);
    return (
      <div style={page}>
        <p style={{ textAlign: 'center', fontSize: 18, marginTop: 24 }}>
          {phase === 'measuringDown'
            ? '楽な高さから、少しずつ低く「んー」とスライドしてください'
            : '楽な高さから、少しずつ高く「んー」とスライドしてください'}
        </p>
        <div style={{ textAlign: 'center', fontSize: 48, fontWeight: 700, marginTop: 24 }}>{seconds}</div>
        <p style={{ textAlign: 'center', fontSize: 22, color: '#2e7d32', marginTop: 16, minHeight: 30 }}>
          いま: {noteText || '　'}
        </p>
        <button style={{ ...subBtn, marginTop: 40 }} onClick={onBack}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- 判定中(過渡) ----
  if (phase === 'analyzing') {
    return (
      <div style={page}>
        <p style={{ textAlign: 'center', marginTop: 80 }}>判定中…</p>
      </div>
    );
  }

  // ---- RC-3 失敗 ----
  if (phase === 'failed') {
    return (
      <div style={page}>
        <div style={card}>
          <p>うまく測れませんでした。もう一度、ゆっくりスライドしてみてください</p>
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
