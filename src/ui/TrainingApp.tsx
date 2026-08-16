// Level 2「1音合わせ」本番UI。画面フロー・文言の正本は docs/UX_TRAINING.md §2。
import { useEffect, useRef, useState } from 'react';
import { AudioSession } from '../platform/audioSession';
import {
  ExerciseEngine,
  type EngineState,
  type ExerciseOutcome,
  type LiveDisplay,
} from '../core/exercise/engine';
import { makeLevel2Spec, type VoiceRange } from '../core/exercise/level2';
import type { ExerciseSpec } from '../core/types';
import { midiToSolfege } from '../core/pitch/scale';
import { loadSettings, saveSettings } from '../data/settings';
import { createProgressStore } from '../data/progressStore';
import { Indicator } from './Indicator';
import { ProgressScreen } from './ProgressScreen';
import { liveStatusText, resultCopy, signedMedianCentsVsTarget } from './copy';

type Screen = 'home' | 'micCheck' | 'range' | 'training' | 'result' | 'progress';

// localStorage を包むだけの薄いラッパーなのでモジュールスコープで1つ生成すれば十分(ADR-004)
const progressStore = createProgressStore();

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

// 状態テキストの150msヒステリシス(UX_TRAINING §4.4。phase切替は即時)
// updater 内で ref を書き換えない純粋な実装(レビューm-7: StrictMode二重実行対策)
function useStatusText(live: LiveDisplay | null, phase: 'playing' | 'waiting' | 'active'): string {
  const [text, setText] = useState('');
  const textRef = useRef('');
  const pendingRef = useRef<{ t: string; since: number } | null>(null);
  const phaseRef = useRef(phase);
  useEffect(() => {
    const t = liveStatusText(live?.cents ?? null, live?.voicing ?? 'silent', phase);
    const now = performance.now();
    const commit = (v: string) => {
      pendingRef.current = null;
      textRef.current = v;
      setText(v);
    };
    if (phaseRef.current !== phase) {
      phaseRef.current = phase;
      commit(t);
      return;
    }
    if (t === textRef.current) {
      pendingRef.current = null;
      return;
    }
    if (pendingRef.current?.t !== t) {
      pendingRef.current = { t, since: now };
      return;
    }
    if (now - pendingRef.current.since >= 150) commit(t);
  }, [live, phase]);
  return text;
}

export function TrainingApp() {
  const engineRef = useRef<ExerciseEngine | null>(null);
  const [settings, setSettings] = useState(loadSettings());
  const [screen, setScreen] = useState<Screen>('home');
  const [engineState, setEngineState] = useState<EngineState>('idle');
  const [live, setLive] = useState<LiveDisplay | null>(null);
  const [levelDb, setLevelDb] = useState(-Infinity);
  const [heard, setHeard] = useState(false);
  const [outcome, setOutcome] = useState<ExerciseOutcome | null>(null);
  // セッションを跨いで永続(ADR-004)。store.practiceCount() は validity=ok のみ数える
  const [practiceCount, setPracticeCount] = useState(() => progressStore.practiceCount());
  const [showDetail, setShowDetail] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [micHint, setMicHint] = useState(false);
  // いま練習中の目標(SC-4の音名表示用。「何が難しいのか分からない」対策 — UX §2 SC-4)
  const [currentSpec, setCurrentSpec] = useState<ExerciseSpec | null>(null);

  if (engineRef.current === null) {
    engineRef.current = new ExerciseEngine(new AudioSession(), {
      onState: (s) => {
        setEngineState(s);
        if (s === 'listening') setLive(null);
      },
      onLive: (d) => setLive(d),
      onLevel: (db) => {
        setLevelDb(db);
        if (db > -45) setHeard(true);
      },
      onResult: (o) => {
        progressStore.append(o.result); // validity=ok のみ保存される(ADR-004)
        setPracticeCount(progressStore.practiceCount()); // storeから再取得(無効試行は増えない)
        setOutcome(o);
        setShowDetail(false);
        setScreen('result');
      },
      onError: (m) => setErrorMsg(m), // 白画面防止(レビューM-9)。training画面のエラーカードで表示
    });
  }
  const engine = engineRef.current;

  // バックグラウンド遷移・着信 → 録音破棄して idle(TRAINING_MODEL.md 遷移表)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        engine.cancel();
        setScreen('home');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [engine]);

  const startTraining = (range: VoiceRange) => {
    setErrorMsg(null);
    setScreen('training');
    const spec = makeLevel2Spec(range);
    setCurrentSpec(spec);
    void engine.beginExercise(spec);
  };

  const onStart = () => {
    setErrorMsg(null);
    if (!settings.firstRunDone) {
      setScreen('micCheck');
      setMicHint(false);
      window.setTimeout(() => setMicHint(true), 5000);
      void engine.startSession();
    } else if (!settings.range) {
      setScreen('range');
    } else {
      startTraining(settings.range);
    }
  };

  const onMicCheckDone = () => {
    const next = { ...settings, firstRunDone: true };
    setSettings(next);
    saveSettings(next);
    if (next.range) startTraining(next.range);
    else setScreen('range');
  };

  const onRangeSelect = (range: VoiceRange) => {
    const next = { ...settings, range };
    setSettings(next);
    saveSettings(next);
    startTraining(range);
  };

  const goHome = () => {
    engine.cancel();
    setScreen('home');
  };

  const phase: 'playing' | 'waiting' | 'active' =
    engineState === 'playingReference' ? 'playing' : engineState === 'listening' ? 'waiting' : 'active';
  const statusText = useStatusText(live, phase);

  // ---- SC-1 ホーム ----
  if (screen === 'home') {
    return (
      <div style={page}>
        <h1 style={{ fontSize: 22 }}>ボイトレ</h1>
        <p>こんにちは。今日も声を出してみましょう。</p>
        {practiceCount > 0 && (
          <p style={{ color: '#888', fontSize: 14 }}>これまで {practiceCount} 回練習しました</p>
        )}
        <div style={card}>
          <div style={{ fontSize: 14, color: '#888' }}>今日の練習</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>音の高さを合わせる練習</div>
        </div>
        <button style={bigBtn} onClick={onStart}>
          ▶ はじめる
        </button>
        {practiceCount > 0 && (
          <button style={subBtn} onClick={() => setScreen('progress')}>
            せいちょうを見る
          </button>
        )}
        <p style={{ fontSize: 12, color: '#aaa', marginTop: 24 }}>
          イヤホンをつけると、お手本の音がじゃまをせず、より正確に練習できます(なくても練習できます)
        </p>
      </div>
    );
  }

  // ---- SC-2 マイク許可・音量チェック ----
  if (screen === 'micCheck') {
    const pct = Number.isFinite(levelDb) ? Math.max(0, Math.min(100, ((levelDb + 60) / 50) * 100)) : 0;
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>はじめる前に</h2>
        <p>まわりが静かな場所で練習すると、声を正しく拾えます。可能であれば、静かな部屋に移動してください。</p>
        {engineState === 'micDenied' ? (
          <div style={card}>
            <p>マイクが使えないと練習できません。ブラウザの設定からマイクを許可して、開き直してください。</p>
          </div>
        ) : (
          <>
            <p style={{ marginTop: 24 }}>「んー」と声を出してみてください。声が届いているか確認します。</p>
            <div style={{ height: 18, background: '#eef0f3', borderRadius: 9, overflow: 'hidden', marginTop: 8 }}>
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: '#2e9e5b',
                  transition: 'width 100ms linear',
                }}
              />
            </div>
            {heard && <p style={{ color: '#2e9e5b', fontWeight: 700 }}>声が届いています ✓</p>}
            {!heard && micHint && (
              <p style={{ color: '#888' }}>
                まだ声が届いていないようです。マイクに向かって、もう少し大きな声を出してみてください。
              </p>
            )}
            {/* 声を検出できなくても永久ブロックしない(レビューM-7 / UX §6) */}
            {(heard || micHint) && (
              <button style={heard ? bigBtn : subBtn} onClick={onMicCheckDone}>
                つぎへ
              </button>
            )}
          </>
        )}
        <button style={subBtn} onClick={goHome}>
          ← もどる
        </button>
      </div>
    );
  }

  // ---- SC-3 声域の簡易選択 ----
  if (screen === 'range') {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>ふだんの声に近いのはどちらですか?</h2>
        <button style={bigBtn} onClick={() => onRangeSelect('low')}>
          低めの声
        </button>
        <button style={{ ...bigBtn, background: '#1565c0' }} onClick={() => onRangeSelect('high')}>
          高めの声
        </button>
        <p style={{ fontSize: 13, color: '#888', marginTop: 16 }}>あとから変更できます</p>
      </div>
    );
  }

  // ---- SC-4 お手本再生 → 発声中のリアルタイム画面 ----
  if (screen === 'training') {
    return (
      <div style={page}>
        {engineState === 'calibrating' && <p style={{ textAlign: 'center', marginTop: 80 }}>準備中…(まわりの音を確認しています)</p>}
        {engineState === 'tooNoisy' && (
          <div style={card}>
            <p>まわりの音が大きいようです。静かな場所に移動して、もう一度お試しください。</p>
            <button style={bigBtn} onClick={() => engine.retry()}>
              もう一度
            </button>
          </div>
        )}
        {engineState === 'listenTimeout' && (
          <div style={card}>
            <p>声が聞こえませんでした。お手本が聞こえたら、同じ高さで「んー」と声を出してみてください。</p>
            <button style={bigBtn} onClick={() => engine.retry()}>
              もう一回
            </button>
          </div>
        )}
        {engineState === 'micDenied' && (
          <div style={card}>
            <p>マイクが使えないと練習できません。ブラウザの設定からマイクを許可してください。</p>
          </div>
        )}
        {engineState === 'idle' && errorMsg && (
          <div style={card}>
            <p>うまく動きませんでした。もう一度お試しください。</p>
            <p style={{ fontSize: 12, color: '#888' }}>{errorMsg}</p>
            <button style={bigBtn} onClick={() => {
              setErrorMsg(null);
              engine.retry();
            }}>
              もう一回
            </button>
          </div>
        )}
        {(engineState === 'playingReference' ||
          engineState === 'listening' ||
          engineState === 'phonating' ||
          engineState === 'scoring') && (
          <>
            {currentSpec && (
              <p style={{ textAlign: 'center', fontSize: 14, color: '#888', marginTop: 24 }}>
                お手本の音: {midiToSolfege(currentSpec.targets[0].midiNote)}
              </p>
            )}
            <p style={{ textAlign: 'center', fontSize: 18, minHeight: 28, marginTop: 16 }}>
              {engineState === 'scoring' ? '判定中…' : statusText}
            </p>
            <Indicator cents={engineState === 'phonating' ? (live?.cents ?? null) : null} />
            {(engineState === 'listening' || engineState === 'phonating') && (
              <button style={subBtn} onClick={() => engine.replayReference()}>
                🔊 もう一度お手本を聞く
              </button>
            )}
          </>
        )}
        <button style={{ ...subBtn, marginTop: 40 }} onClick={goHome}>
          ← やめる
        </button>
      </div>
    );
  }

  // ---- SC-5 結果画面 ----
  if (screen === 'result' && outcome) {
    const copy = resultCopy(outcome);
    const m = outcome.result.metrics;
    return (
      <div style={page}>
        <div style={{ textAlign: 'center', fontSize: 40, marginTop: 24 }}>✓</div>
        <p style={{ fontSize: 18, textAlign: 'center' }}>{copy.praise}</p>
        <div style={card}>
          <div style={{ fontSize: 15 }}>次は</div>
          <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>「{copy.headline}」</div>
          <div style={{ fontSize: 15 }}>を練習しましょう</div>
          <p style={{ fontSize: 14, color: '#555', marginTop: 8 }}>{copy.action}</p>
        </div>
        <button style={bigBtn} onClick={() => {
          setScreen('training');
          engine.retry();
        }}>
          もう一回
        </button>
        <button
          style={{ ...bigBtn, background: '#1565c0' }}
          onClick={() => {
            setScreen('training');
            setCurrentSpec(outcome.next.spec);
            void engine.beginExercise(outcome.next.spec);
          }}
        >
          次の練習へ
        </button>
        <button style={subBtn} onClick={goHome}>
          ホームへ
        </button>
        <p style={{ fontSize: 13, color: '#888', marginTop: 16, cursor: 'pointer' }} onClick={() => setShowDetail((v) => !v)}>
          詳しく見る {showDetail ? '▲' : '>'}
        </p>
        {showDetail && (
          <div style={{ ...card, fontSize: 13, lineHeight: 2 }}>
            お手本の音: {midiToSolfege(outcome.result.spec.targets[0].midiNote)}
            <br />
            {(() => {
              const bias = signedMedianCentsVsTarget(outcome.result);
              if (bias === null) return null;
              const label = bias <= -30 ? 'お手本より低め' : bias >= 30 ? 'お手本より高め' : 'ちょうど';
              return (
                <>
                  傾向: {label}({Math.round(bias)})
                  <br />
                </>
              );
            })()}
            高さの一致: {(m.pitchAccuracy * 100).toFixed(0)}%
            <br />
            ズレの中央値: {m.medianAbsCents.toFixed(0)}(小さいほど合っています)
            <br />
            声の安定: {m.pitchStability === null ? '測定できず' : `${(m.pitchStability * 100).toFixed(0)}%`}
            <br />
            音の入り: {m.attackAccuracy === null ? '測定できず' : `${(m.attackAccuracy * 100).toFixed(0)}%`}
          </div>
        )}
      </div>
    );
  }

  // ---- 成長記録画面(Phase 7) ----
  if (screen === 'progress') {
    return <ProgressScreen store={progressStore} onBack={() => setScreen('home')} />;
  }

  return null;
}
