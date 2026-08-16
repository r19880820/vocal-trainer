// Phase 1 開発用デバッグ画面(?debug で表示。Phase 0.5 実機読み戻しの確認用)。
// 本番のトレーニングUI(TrainingApp)とは別物。専門用語・生数値を意図的に表示する。
// 「較正ツール」セクション(ROADMAP.md Phase 1 宿題): 録音・再生ハーネス/起動時セルフテスト/
// ループバック遅延実測。いずれも docs/AUDIO_ANALYSIS.md §1・§6 の受入項目に対応する。
import { useEffect, useRef, useState } from 'react';
import { AudioSession, type CaptureInfo } from '../platform/audioSession';
import { encodeWavPcm16 } from '../platform/wav';
import { hzToMidi, midiToHz, midiToNoteName } from '../core/pitch/conversions';
import { runPipelineOffline } from '../core/offline';
import { LATENCY_BUDGET_MS } from '../core/constants';
import type { RawPitchSample } from '../core/types';

const box: React.CSSProperties = {
  background: '#f4f4f6',
  borderRadius: 12,
  padding: '12px 16px',
  marginBottom: 12,
};
const btn: React.CSSProperties = {
  fontSize: 18,
  padding: '14px 18px',
  borderRadius: 12,
  border: 'none',
  marginRight: 8,
  marginBottom: 8,
  cursor: 'pointer',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 録音PCM内で「直前100msのRMSの5倍超」の振幅急増が最初に現れたサンプル位置を検出し、
 * 壁時計時刻(recordingStartPerfMs 起点)に変換して返す。見つからなければ null。
 * 実装判断: 真の意味での逐次オンライン検出(ブロック到着ごとにその場で判定)ではなく、
 * 録音停止後にバッファ全体を走査する準オンライン方式(固定サンプリングレートのPCMなので
 * sampleIndex→壁時計時刻の変換は録音開始時刻からの単純な線形写像で近似できる)。
 * 検出される「時刻」自体は変わらないため遅延測定の妥当性には影響しない(詳細は最終報告)。
 */
function detectClickOnsetMs(pcm: Float32Array, sampleRate: number, recordingStartPerfMs: number): number | null {
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.005)); // 5ms
  const baselineHops = Math.max(1, Math.round((sampleRate * 0.1) / hopSamples)); // 直前100ms
  const numHops = Math.floor(pcm.length / hopSamples);
  if (numHops <= baselineHops) return null;

  const hopRms = new Array<number>(numHops);
  for (let h = 0; h < numHops; h++) {
    let sum = 0;
    const start = h * hopSamples;
    for (let i = start; i < start + hopSamples; i++) sum += pcm[i] * pcm[i];
    hopRms[h] = Math.sqrt(sum / hopSamples);
  }

  let baselineSum = 0;
  for (let h = 0; h < baselineHops; h++) baselineSum += hopRms[h];

  for (let h = baselineHops; h < numHops; h++) {
    const baseline = baselineSum / baselineHops;
    const spikeThreshold = Math.max(baseline * 5, 1e-6); // baseline=0(完全無音)でも検出できるように下駄を履かせる
    if (hopRms[h] > spikeThreshold) {
      const sampleIdx = h * hopSamples;
      return recordingStartPerfMs + (sampleIdx / sampleRate) * 1000;
    }
    baselineSum += hopRms[h] - hopRms[h - baselineHops];
  }
  return null;
}

type SelfTestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'pass'; measuredHz: number; voicedCount: number }
  | { status: 'fail'; measuredHz: number | null; voicedCount: number; reason: string };

type LatencyState =
  | { status: 'idle' }
  | { status: 'running'; trialsDone: number }
  | { status: 'done'; trialsMs: number[]; medianMs: number | null };

export function DebugPage() {
  const sessionRef = useRef<AudioSession>(new AudioSession());
  const latestRef = useRef<RawPitchSample | null>(null);
  const countRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [sample, setSample] = useState<RawPitchSample | null>(null);
  const [rate, setRate] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const [manualRecording, setManualRecording] = useState(false);
  const [selfTest, setSelfTest] = useState<SelfTestState>({ status: 'idle' });
  const [latency, setLatency] = useState<LatencyState>({ status: 'idle' });

  useEffect(() => {
    if (!running) return;
    let prevCount = 0;
    const id = window.setInterval(() => {
      setSample(latestRef.current);
      setRate((countRef.current - prevCount) * 10);
      prevCount = countRef.current;
    }, 100);
    return () => window.clearInterval(id);
  }, [running]);

  const pushError = (m: string) =>
    setErrors((prev) => [...prev.slice(-4), `${new Date().toLocaleTimeString()} ${m}`]);

  const start = async () => {
    try {
      const captureInfo = await sessionRef.current.start((s) => {
        latestRef.current = s;
        countRef.current += 1;
      }, pushError);
      setInfo(captureInfo);
      setRunning(true);
    } catch (e) {
      pushError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    sessionRef.current.stop();
    setRunning(false);
    setManualRecording(false);
  };

  const playTone = (midi: number) => {
    void sessionRef.current.playTone(midiToHz(midi), 1500).catch((e) => pushError(String(e)));
  };

  // --- 較正ツール: 録音・再生ハーネス ---
  const toggleManualRecording = () => {
    const next = !manualRecording;
    sessionRef.current.setRecording(next);
    setManualRecording(next);
  };

  const downloadRecording = () => {
    const rec = sessionRef.current.getRecording();
    if (!rec) {
      pushError('ダウンロードできる録音がありません(先に録音してください)');
      return;
    }
    const blob = encodeWavPcm16(rec.pcm, rec.sampleRate);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocal-trainer-recording-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- 較正ツール: 起動時セルフテスト(440Hz) ---
  const runSelfTest = async () => {
    if (!running) {
      pushError('セルフテストにはマイク開始が必要です');
      return;
    }
    setSelfTest({ status: 'running' });
    try {
      sessionRef.current.setRecording(true);
      // 録音先頭500msは runPipelineOffline のノイズフロア推定窓。ここにお手本音が入ると
      // 推定フロアがトーン自身のレベルまで持ち上がり、全サンプルが tooQuiet 化して誤FAILする
      // (実装エージェント報告の懸念を確定バグとして処置)。600msの無音リードインで窓を保護する。
      await sleep(600);
      await sessionRef.current.playTone(440, 1200);
      await sleep(300);
      sessionRef.current.setRecording(false);

      const rec = sessionRef.current.getRecording();
      if (!rec) {
        setSelfTest({ status: 'fail', measuredHz: null, voicedCount: 0, reason: '録音データを取得できませんでした' });
        return;
      }
      const { processed } = runPipelineOffline(rec.pcm, rec.sampleRate);
      const voicedHz = processed.filter((p) => p.voicing === 'voiced').map((p) => p.frequencyHzForScoring);
      const measured = medianOf(voicedHz);

      if (measured === null) {
        setSelfTest({ status: 'fail', measuredHz: null, voicedCount: 0, reason: '有声区間を検出できませんでした' });
        return;
      }
      const pass = Math.abs(measured - 440) <= 20;
      if (pass) {
        setSelfTest({ status: 'pass', measuredHz: measured, voicedCount: voicedHz.length });
      } else {
        setSelfTest({
          status: 'fail',
          measuredHz: measured,
          voicedCount: voicedHz.length,
          reason: `検出値が440±20Hzから外れています(差 ${(measured - 440).toFixed(1)}Hz)`,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushError(`セルフテスト失敗: ${msg}`);
      setSelfTest({ status: 'fail', measuredHz: null, voicedCount: 0, reason: msg });
    }
  };

  // --- 較正ツール: ループバック遅延実測 ---
  const runLatencyTest = async () => {
    if (!running) {
      pushError('遅延測定にはマイク開始が必要です');
      return;
    }
    setLatency({ status: 'running', trialsDone: 0 });
    const trialsMs: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        sessionRef.current.setRecording(true);
        await sleep(200); // クリック前の無音区間(直前100msRMSベースライン確保)
        const playAtMs = performance.now(); // (a) 再生指示時刻
        await sessionRef.current.playClick(5);
        await sleep(300); // クリック後の録音尾を確保
        sessionRef.current.setRecording(false);

        const startPerfMs = sessionRef.current.getRecordingStartTime();
        const rec = sessionRef.current.getRecording();
        if (rec && startPerfMs !== null) {
          const detectedMs = detectClickOnsetMs(rec.pcm, rec.sampleRate, startPerfMs); // (b) オンライン検出時刻相当
          if (detectedMs !== null) trialsMs.push(detectedMs - playAtMs);
        }
        setLatency({ status: 'running', trialsDone: i + 1 });
        await sleep(150);
      }
    } catch (e) {
      pushError(e instanceof Error ? e.message : String(e));
    }
    setLatency({ status: 'done', trialsMs, medianMs: medianOf(trialsMs) });
  };

  const midi = sample && sample.frequencyHz > 0 ? hzToMidi(sample.frequencyHz) : null;
  const nearest = midi !== null ? Math.round(midi) : null;
  const cents = midi !== null && nearest !== null ? Math.round((midi - nearest) * 100) : null;
  const ampDb = sample && sample.amplitude > 0 ? 20 * Math.log10(sample.amplitude) : -Infinity;
  const settings = info?.trackSettings as
    | (MediaTrackSettings & { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean })
    | undefined;

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20 }}>ボイトレ 開発デバッグ画面</h1>

      <div>
        {!running ? (
          <button style={{ ...btn, background: '#2e7d32', color: '#fff' }} onClick={() => void start()}>
            🎤 マイク開始
          </button>
        ) : (
          <button style={{ ...btn, background: '#555', color: '#fff' }} onClick={stop}>
            ■ 停止
          </button>
        )}
        <button style={{ ...btn, background: '#1565c0', color: '#fff' }} onClick={() => playTone(60)}>
          ♪ C4
        </button>
        <button style={{ ...btn, background: '#1565c0', color: '#fff' }} onClick={() => playTone(69)}>
          ♪ A4 (440Hz)
        </button>
      </div>

      <div style={box}>
        <div style={{ fontSize: 44, fontWeight: 700 }}>
          {sample && sample.frequencyHz > 0 ? `${sample.frequencyHz.toFixed(1)} Hz` : '—'}
        </div>
        <div style={{ fontSize: 28 }}>
          {nearest !== null ? `${midiToNoteName(nearest)} ${cents! >= 0 ? '+' : ''}${cents} cent` : ''}
        </div>
        {sample && (
          <div style={{ fontSize: 14, color: '#444', marginTop: 8 }}>
            confidence: {sample.confidence.toFixed(2)}
            {' / '}belowThreshold: {String(sample.belowThreshold)}
            {' / '}RMS: {ampDb === -Infinity ? '-∞' : ampDb.toFixed(1)} dBFS
            {' / '}更新: {rate}/s
          </div>
        )}
      </div>

      {info && (
        <div style={box}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>実機読み戻し(Phase 0.5 検証項目)</div>
          <div style={{ fontSize: 14, lineHeight: 1.8 }}>
            AudioContext.sampleRate: <b>{info.contextSampleRate} Hz</b>
            <br />
            内部レート(÷2): <b>{info.internalSampleRate} Hz</b>
            <br />
            echoCancellation: <b>{String(settings?.echoCancellation ?? '不明')}</b>(false であるべき)
            <br />
            noiseSuppression: <b>{String(settings?.noiseSuppression ?? '不明')}</b>(false であるべき)
            <br />
            autoGainControl: <b>{String(settings?.autoGainControl ?? '不明')}</b>(false であるべき)
            <br />
            <details>
              <summary>getSettings() 全体</summary>
              <pre style={{ fontSize: 11, overflowX: 'auto' }}>{JSON.stringify(settings, null, 2)}</pre>
            </details>
          </div>
        </div>
      )}

      <div style={box}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>較正ツール(Phase 1 宿題)</div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>
            録音・再生ハーネス: 任意の発声を録って再解析できる(閾値較正の再現性の要)。
          </div>
          <button
            style={{ ...btn, background: manualRecording ? '#c62828' : '#6a1b9a', color: '#fff' }}
            onClick={toggleManualRecording}
            disabled={!running}
          >
            {manualRecording ? '■ 録音停止' : '● 録音開始'}
          </button>
          <button style={{ ...btn, background: '#455a64', color: '#fff' }} onClick={downloadRecording}>
            ⬇ 録音WAVをダウンロード
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>
            起動時セルフテスト: マイク開始中に440Hzを1.2秒再生→自動録音→解析。
            <b>イヤホン装着時は失敗します(スピーカー使用時のみ有効。マイクへの回り込みが前提)</b>。
          </div>
          <button
            style={{ ...btn, background: '#ef6c00', color: '#fff' }}
            onClick={() => void runSelfTest()}
            disabled={!running || selfTest.status === 'running'}
          >
            {selfTest.status === 'running' ? '実行中…' : '▶ セルフテスト実行'}
          </button>
          {selfTest.status === 'pass' && (
            <div style={{ fontSize: 14, color: '#2e7d32', fontWeight: 700, marginTop: 4 }}>
              PASS — 実測 {selfTest.measuredHz.toFixed(1)}Hz(voiced n={selfTest.voicedCount})
            </div>
          )}
          {selfTest.status === 'fail' && (
            <div style={{ fontSize: 14, color: '#c62828', fontWeight: 700, marginTop: 4 }}>
              FAIL — {selfTest.reason}
              {selfTest.measuredHz !== null && `(実測 ${selfTest.measuredHz.toFixed(1)}Hz, voiced n=${selfTest.voicedCount})`}
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>
            ループバック遅延実測: クリック音の再生指示〜録音での検出までの時間差(3回・中央値)。
            出力+入力+処理の合計遅延であり<b>表示遅延の上界</b>(目標 LATENCY_BUDGET_MS={LATENCY_BUDGET_MS}ms)。
          </div>
          <button
            style={{ ...btn, background: '#00838f', color: '#fff' }}
            onClick={() => void runLatencyTest()}
            disabled={!running || latency.status === 'running'}
          >
            {latency.status === 'running' ? `測定中… (${latency.trialsDone}/3)` : '⏱ 遅延測定'}
          </button>
          {latency.status === 'done' && (
            <div style={{ fontSize: 14, marginTop: 4 }}>
              試行: {latency.trialsMs.map((t) => `${t.toFixed(0)}ms`).join(' / ') || '検出できず'}
              <br />
              {latency.medianMs !== null ? (
                <span
                  style={{
                    fontWeight: 700,
                    color: latency.medianMs <= LATENCY_BUDGET_MS ? '#2e7d32' : '#ef6c00',
                  }}
                >
                  中央値 {latency.medianMs.toFixed(0)}ms
                  {latency.medianMs <= LATENCY_BUDGET_MS
                    ? ` (予算${LATENCY_BUDGET_MS}ms以内)`
                    : ` (WARN: 予算${LATENCY_BUDGET_MS}msを超過)`}
                </span>
              ) : (
                <span style={{ color: '#c62828', fontWeight: 700 }}>クリックを検出できませんでした</span>
              )}
            </div>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div style={{ ...box, background: '#fdecea' }}>
          <div style={{ fontWeight: 700 }}>エラー</div>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12 }}>
              {e}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12, color: '#888' }}>
        使い方: 「♪ A4」でお手本を鳴らし、「マイク開始」後に同じ高さで「んー」と発声。
        セルフテスト: マイク開始中に「♪ A4」を鳴らすと 440±20Hz 付近を検出するはず(スピーカー使用時)。
      </div>
    </div>
  );
}
