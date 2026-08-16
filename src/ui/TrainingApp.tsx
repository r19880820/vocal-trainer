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
import { RANGE_MIN_COMFORT_BINS } from '../core/constants';
import { buildDailyMenu, type MenuStep } from '../core/menu/buildDailyMenu';
import { loadSettings, saveSettings, type Settings } from '../data/settings';
import { createProgressStore } from '../data/progressStore';
import { Indicator } from './Indicator';
import { ProgressScreen } from './ProgressScreen';
import { RangeCheckScreen } from './RangeCheckScreen';
import { Level1Screen } from './Level1Screen';
import { Level3Screen } from './Level3Screen';
import { liveStatusText, resultCopy, signedMedianCentsVsTarget } from './copy';

type Screen =
  | 'home'
  | 'micCheck'
  | 'range'
  | 'training'
  | 'result'
  | 'progress'
  | 'rangeCheck'
  | 'level1'
  | 'level3'
  | 'menuIntro'
  | 'menuStepIntro'
  | 'menuDone';

// 「今日のメニュー」M-1の番号表示(UX_TRAINING.md §5e)。4ステップ固定(TRAINING_MODEL.md)なのでこの4文字で足りる。
const MENU_STEP_NUMBERS = ['①', '②', '③', '④'];

// localStorage を包むだけの薄いラッパーなのでモジュールスコープで1つ生成すれば十分(ADR-004)
const progressStore = createProgressStore();

/** 音域チェック済みか(型ガード。trueの分岐ではrangeComfortLow/HighMidiがnumberへ narrow される)。
 * 幅が RANGE_MIN_COMFORT_BINS 未満の保存値は誤測定(2026-08-16事故: 旧解析が幅3半音を返した)
 * とみなして未測定扱いにする — 修正前に保存されたデータからの防御。 */
function hasMeasuredRange(
  s: Settings
): s is Settings & { rangeComfortLowMidi: number; rangeComfortHighMidi: number } {
  return (
    s.rangeComfortLowMidi !== null &&
    s.rangeComfortHighMidi !== null &&
    s.rangeComfortHighMidi - s.rangeComfortLowMidi + 1 >= RANGE_MIN_COMFORT_BINS
  );
}

/** 実数MIDI→標準MIDIオクターブ番号(60=C4)。RC-3同様の表示専用ヘルパー(UX_TRAINING §5b)。 */
function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

function noteLabel(midi: number | null): string {
  if (midi === null) return '';
  return `${midiToSolfege(midi)}${octaveOf(midi)}`;
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
  // 「今日のメニュー」起点で初回オンボーディング(SC-2/SC-3)を通過中か(通過後にメニュー表へ合流する)
  const [pendingMenu, setPendingMenu] = useState(false);
  // いま練習中の目標(SC-4の音名表示用。「何が難しいのか分からない」対策 — UX §2 SC-4)
  const [currentSpec, setCurrentSpec] = useState<ExerciseSpec | null>(null);
  // 「今日のメニュー」(UX_TRAINING.md §5e / TRAINING_MODEL.md「今日のメニュー」)。
  // menu!==null の間はメニュー実行中(各画面の「メニュー i/4」表示・result画面のボタン差し替えに使う)。
  const [menu, setMenu] = useState<MenuStep[] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  // 音域チェック専用のAudioSession(engineが内部に持つものとは別インスタンス。マイクリソースの
  // 競合を避けるため、engine.cancel()してから生成する — 詳細は最終報告のAudioSession共有方式を参照)。
  const rangeSessionRef = useRef<AudioSession | null>(null);
  // Level 1「音の上下」専用のAudioSession(rangeSessionRefと同じ理由で専用インスタンスを生成する)。
  const level1SessionRef = useRef<AudioSession | null>(null);
  // Level 3「2音まねっこ」専用のAudioSession(level1SessionRefと同じ理由で専用インスタンスを生成する)。
  const level3SessionRef = useRef<AudioSession | null>(null);

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

  // バックグラウンド遷移・着信 → 録音破棄して idle(TRAINING_MODEL.md 遷移表)。
  // 音域チェック・Level1・Level3中も同じ安全則を適用する(専用sessionすべてのマイクを必ず解放する —
  // 放置するとバックグラウンドでもマイクが起動したままになる)。
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        engine.cancel();
        rangeSessionRef.current?.stop();
        rangeSessionRef.current = null;
        level1SessionRef.current?.stop();
        level1SessionRef.current = null;
        level3SessionRef.current?.stop();
        level3SessionRef.current = null;
        setMenu(null); // メニュー実行中のバックグラウンド遷移も途中離脱として扱う(TRAINING_MODEL.md 遷移表)
        setScreen('home');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [engine]);

  const startTraining = (range: VoiceRange) => {
    setErrorMsg(null);
    setScreen('training');
    // 音域チェック済みなら「楽に出せる範囲」を優先(TRAINING_MODEL.md「目標音の範囲」)。
    const comfortRange = hasMeasuredRange(settings)
      ? { lowMidi: settings.rangeComfortLowMidi, highMidi: settings.rangeComfortHighMidi }
      : null;
    const spec = makeLevel2Spec(range, undefined, comfortRange);
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
    } else if (hasMeasuredRange(settings)) {
      // 測定済みなら声域選択(SC-3)をスキップしてよい(UX_TRAINING.md §2)
      startTraining(settings.range ?? 'low');
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
    if (pendingMenu) {
      // メニュー起点のオンボーディング継続。SC-2で起動したマイクはどの分岐でも即解放する
      // (Codexレビュー指摘: 声域選択画面へ進む分岐で解放漏れ=選択中もマイクが動き続けていた)。
      // メニュー表画面・声域選択ではマイク不要で、各ステップが自分で取り直す
      engine.cancel();
      if (!hasMeasuredRange(next) && !next.range) {
        setScreen('range');
        return;
      }
      setPendingMenu(false);
      openMenuIntro(next);
      return;
    }
    if (hasMeasuredRange(next)) startTraining(next.range ?? 'low');
    else if (next.range) startTraining(next.range);
    else setScreen('range');
  };

  const onRangeSelect = (range: VoiceRange) => {
    const next = { ...settings, range };
    setSettings(next);
    saveSettings(next);
    if (pendingMenu) {
      setPendingMenu(false);
      engine.cancel();
      openMenuIntro(next);
      return;
    }
    startTraining(range);
  };

  const goHome = () => {
    engine.cancel();
    setMenu(null); // 「← やめる/ホームへ」= メニューの途中離脱(責めない。TRAINING_MODEL.md/UX §5e M-2)
    setPendingMenu(false);
    setScreen('home');
  };

  // ---- 「今日のメニュー」(M-1〜M-3。UX_TRAINING.md §5e / TRAINING_MODEL.md「今日のメニュー」) ----

  /** Settings + SkillSnapshot履歴からメニューを編成する(buildDailyMenuへの入力組み立てのみ担う)。
   * オンボーディング直後は state の settings が古いため、確定済み Settings を引数で受け取れるようにする。 */
  const buildMenuList = (s: Settings = settings): MenuStep[] => {
    const comfortRange = hasMeasuredRange(s)
      ? { lowMidi: s.rangeComfortLowMidi, highMidi: s.rangeComfortHighMidi }
      : null;
    const range: VoiceRange = s.range ?? 'low';
    return buildDailyMenu({ comfortRange, range, snapshots: progressStore.loadAll() });
  };

  const openMenuIntro = (s: Settings) => {
    setMenu(buildMenuList(s));
    setMenuIndex(0);
    setScreen('menuIntro');
  };

  const onStartMenu = () => {
    setErrorMsg(null);
    // 初回はメニュー起点でもオンボーディング(SC-2マイク確認→SC-3声域選択)を通す
    // (実装レビュー懸念対応: メニューが主導線になったため、案内なしのマイク許可プロンプトや
    // 声域'low'既定のまま的外れな音域で始まる事故を避ける)
    if (!settings.firstRunDone) {
      setPendingMenu(true);
      setScreen('micCheck');
      setMicHint(false);
      window.setTimeout(() => setMicHint(true), 5000);
      void engine.startSession();
      return;
    }
    if (!hasMeasuredRange(settings) && !settings.range) {
      setPendingMenu(true);
      setScreen('range');
      return;
    }
    openMenuIntro(settings);
  };

  const onMenuIntroBack = () => {
    setMenu(null);
    setPendingMenu(false);
    setScreen('home');
  };

  /** list[index] のステップへ進む。まず案内画面(M-2b)を挟み、[はじめる]で実行する
   * (2026-08-17 ユーザー実走フィードバック「いま何の練習か分からないまま進んだ」対応)。
   * index が範囲外なら完了画面(M-3)へ。 */
  const startMenuStep = (list: MenuStep[], index: number) => {
    const step = list[index];
    if (!step) {
      // 4ステップ完了(finisherはengine駆動なので、ここでマイクを確実に解放する — レビュー指摘:
      // 未解放だとM-3完了画面でマイクが起動したまま残る)。
      engine.cancel();
      setMenu(null);
      setScreen('menuDone');
      return;
    }
    setErrorMsg(null);
    setMenuIndex(index);
    setScreen('menuStepIntro');
  };

  /** 案内画面(M-2b)の[はじめる]から呼ばれる: ステップ種別ごとに実行先を振り分ける。 */
  const launchMenuStep = (step: MenuStep) => {
    setErrorMsg(null);
    if (step.kind === 'level1Set') {
      // 音域チェック・Level1直接起動と同じ方式(engineのマイクを解放してから専用sessionを生成 — 二重マイク防止)
      engine.cancel();
      level1SessionRef.current = new AudioSession();
      setScreen('level1');
      return;
    }
    if (step.kind === 'level3Trial') {
      engine.cancel();
      level3SessionRef.current = new AudioSession();
      setScreen('level3');
      return;
    }
    // warmupLongTone / level2Focus / finisher: 既存のLevel 2フロー(engine)をそのまま使う
    if (!step.spec) return; // 到達しない想定(buildDailyMenuの不変条件)。型安全のためのガード
    setScreen('training');
    setCurrentSpec(step.spec);
    void engine.beginExercise(step.spec);
  };

  /** 「つぎのメニューへ」共通ハンドラ(engine駆動のresult画面・Level1/Level3のonCompleteの両方から呼ばれる)。
   * 現在アクティブかもしれないL1/L3専用sessionを確実に解放してから次のステップへ進む
   * (ステップ切替時に前のsessionを解放する、というタスク要件をここに集約する)。 */
  const onMenuStepComplete = () => {
    if (!menu) return;
    level1SessionRef.current?.stop();
    level1SessionRef.current = null;
    level3SessionRef.current?.stop();
    level3SessionRef.current = null;
    startMenuStep(menu, menuIndex + 1);
  };

  // ---- 音域チェック(RC-1〜RC-3)への遷移 ----
  const onStartRangeCheck = () => {
    setErrorMsg(null);
    // engine.cancel()で先にマイクを解放してから、音域チェック専用のAudioSessionを新規生成する
    // (同一portをengineとRangeCheckScreenで共有すると、engineの内部状態機械と競合しうるため)。
    engine.cancel();
    rangeSessionRef.current = new AudioSession();
    setScreen('rangeCheck');
  };

  const onRangeCheckDone = (next: Settings) => {
    setSettings(next);
  };

  const onRangeCheckBack = () => {
    rangeSessionRef.current?.stop();
    rangeSessionRef.current = null;
    setScreen('home');
  };

  // ---- Level 1「音の上下」への遷移(音域チェックと同じ方式) ----
  const onStartLevel1 = () => {
    setErrorMsg(null);
    engine.cancel();
    level1SessionRef.current = new AudioSession();
    setScreen('level1');
  };

  const onLevel1Back = () => {
    level1SessionRef.current?.stop();
    level1SessionRef.current = null;
    setMenu(null); // メニュー中の途中離脱も含む(単独起動時はもともとnullなので無害)
    setScreen('home');
  };

  // ---- Level 3「2音まねっこ」への遷移(Level 1と同じ方式) ----
  const onStartLevel3 = () => {
    setErrorMsg(null);
    engine.cancel();
    level3SessionRef.current = new AudioSession();
    setScreen('level3');
  };

  const onLevel3Back = () => {
    level3SessionRef.current?.stop();
    level3SessionRef.current = null;
    setMenu(null); // メニュー中の途中離脱も含む(単独起動時はもともとnullなので無害)
    setScreen('home');
  };

  const phase: 'playing' | 'waiting' | 'active' =
    engineState === 'playingReference' ? 'playing' : engineState === 'listening' ? 'waiting' : 'active';
  const statusText = useStatusText(live, phase);

  // ---- SC-1 ホーム(§5e改: 主導線は「今日のメニュー」) ----
  if (screen === 'home') {
    return (
      <div style={page}>
        <h1 style={{ fontSize: 22 }}>ボイトレ</h1>
        <p>こんにちは。今日も声を出してみましょう。</p>
        {practiceCount > 0 && (
          <p style={{ color: '#888', fontSize: 14 }}>これまで {practiceCount} 回練習しました</p>
        )}
        <div style={card}>
          <div style={{ fontSize: 14, color: '#888' }}>今日のメニュー</div>
          <div style={{ fontSize: 16, marginTop: 4 }}>
            {practiceCount > 0
              ? 'あなたの記録から今日の練習を組みました(約10分)'
              : 'まずは基本の練習を組みました(約10分)'}
          </div>
        </div>
        <button style={bigBtn} onClick={onStartMenu}>
          ▶ はじめる
        </button>
        {hasMeasuredRange(settings) ? (
          <>
            <p style={{ fontSize: 13, color: '#888', marginTop: 12 }}>
              あなたの音域: {noteLabel(settings.rangeComfortLowMidi)} 〜 {noteLabel(settings.rangeComfortHighMidi)}
            </p>
            <button
              style={{ ...subBtn, fontSize: 14, padding: '10px 16px', marginTop: 4 }}
              onClick={onStartRangeCheck}
            >
              音域を測りなおす
            </button>
          </>
        ) : (
          <button style={bigBtn} onClick={onStartRangeCheck}>
            音域をはかる
          </button>
        )}
        {practiceCount > 0 && (
          <button style={subBtn} onClick={() => setScreen('progress')}>
            せいちょうを見る
          </button>
        )}

        <h2 style={{ fontSize: 16, color: '#888', marginTop: 32 }}>じぶんで選んで練習</h2>
        <div style={card}>
          <div style={{ fontSize: 14, color: '#888' }}>今日の練習</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>音の高さを合わせる練習</div>
        </div>
        <button style={bigBtn} onClick={onStart}>
          ▶ はじめる
        </button>
        <div style={card}>
          <div style={{ fontSize: 14, color: '#888' }}>耳と声のトレーニング</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>音の上下を聞き分ける練習</div>
        </div>
        <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onStartLevel1}>
          この練習をはじめる
        </button>
        <div style={card}>
          <div style={{ fontSize: 14, color: '#888' }}>耳と声のトレーニング</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>2つの音をまねる練習</div>
        </div>
        <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onStartLevel3}>
          この練習をはじめる
        </button>
        <p style={{ fontSize: 12, color: '#aaa', marginTop: 24 }}>
          イヤホンをつけると、お手本の音がじゃまをせず、より正確に練習できます(なくても練習できます)
        </p>
      </div>
    );
  }

  // ---- M-1 今日のメニュー(開始前) ----
  if (screen === 'menuIntro' && menu) {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20 }}>今日のメニュー</h2>
        {menu.map((step, i) => (
          <div key={i} style={card}>
            <div style={{ fontWeight: 700 }}>
              {MENU_STEP_NUMBERS[i] ?? `${i + 1}.`} {step.title}
            </div>
            <p style={{ fontSize: 14, color: '#555', marginTop: 4 }}>{step.reason}</p>
          </div>
        ))}
        <button style={bigBtn} onClick={() => startMenuStep(menu, 0)}>
          はじめる
        </button>
        <button style={subBtn} onClick={onMenuIntroBack}>
          ← もどる
        </button>
      </div>
    );
  }

  // ---- M-2b ステップ案内(いま何の練習が始まるか — 2026-08-17 ユーザー実走フィードバック対応) ----
  if (screen === 'menuStepIntro' && menu) {
    const step = menu[menuIndex];
    if (step) {
      return (
        <div style={page}>
          <p style={{ textAlign: 'center', fontSize: 12, color: '#aaa' }}>メニュー {menuIndex + 1}/4</p>
          <div style={{ ...card, marginTop: 40 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{step.title}</div>
            <p style={{ fontSize: 15, color: '#555', marginTop: 8 }}>{step.reason}</p>
          </div>
          <button style={bigBtn} onClick={() => launchMenuStep(step)}>
            はじめる
          </button>
          <button style={subBtn} onClick={goHome}>
            ← やめる
          </button>
        </div>
      );
    }
  }

  // ---- M-3 今日のメニュー完了 ----
  if (screen === 'menuDone') {
    return (
      <div style={page}>
        <h2 style={{ fontSize: 20, textAlign: 'center', marginTop: 40 }}>
          今日のメニュー完了!おつかれさまでした 🎉
        </h2>
        <p style={{ textAlign: 'center', color: '#888', marginTop: 12 }}>
          これまで {practiceCount} 回練習しました
        </p>
        <button style={bigBtn} onClick={goHome}>
          ホームへ
        </button>
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
        {menu && (
          <p style={{ textAlign: 'center', fontSize: 12, color: '#aaa' }}>
            メニュー {menuIndex + 1}/4
          </p>
        )}
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

  // ---- SC-5 結果画面(menu!==null 時は M-2 の「メニュー中の結果画面」仕様に差し替え) ----
  if (screen === 'result' && outcome) {
    const copy = resultCopy(outcome);
    const m = outcome.result.metrics;
    const retry = () => {
      setScreen('training');
      engine.retry();
    };
    return (
      <div style={page}>
        {menu && (
          <p style={{ textAlign: 'center', fontSize: 12, color: '#aaa' }}>
            メニュー {menuIndex + 1}/4
          </p>
        )}
        <div style={{ textAlign: 'center', fontSize: 40, marginTop: 24 }}>✓</div>
        <p style={{ fontSize: 18, textAlign: 'center' }}>{copy.praise}</p>
        <div style={card}>
          <div style={{ fontSize: 15 }}>次は</div>
          <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>「{copy.headline}」</div>
          <div style={{ fontSize: 15 }}>を練習しましょう</div>
          <p style={{ fontSize: 14, color: '#555', marginTop: 8 }}>{copy.action}</p>
        </div>
        {menu ? (
          <>
            {/* メニュー中の主ボタン(UX_TRAINING.md §5e M-2)。「次の練習へ」は非表示 */}
            <button style={{ ...bigBtn, background: '#1565c0' }} onClick={onMenuStepComplete}>
              つぎのメニューへ
            </button>
            <button style={bigBtn} onClick={retry}>
              もう一回
            </button>
          </>
        ) : (
          <>
            <button style={bigBtn} onClick={retry}>
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
          </>
        )}
        <button style={subBtn} onClick={goHome}>
          ホームへ
        </button>
        {!menu && (
          <>
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
          </>
        )}
      </div>
    );
  }

  // ---- 成長記録画面(Phase 7) ----
  if (screen === 'progress') {
    return <ProgressScreen store={progressStore} onBack={() => setScreen('home')} />;
  }

  // ---- 音域チェック(RC-1〜RC-3) ----
  if (screen === 'rangeCheck' && rangeSessionRef.current) {
    return <RangeCheckScreen session={rangeSessionRef.current} onDone={onRangeCheckDone} onBack={onRangeCheckBack} />;
  }

  // ---- Level 1「音の上下」(L1-1〜L1-3) ----
  if (screen === 'level1' && level1SessionRef.current) {
    return (
      <Level1Screen
        session={level1SessionRef.current}
        onBack={onLevel1Back}
        menuLabel={menu ? `メニュー ${menuIndex + 1}/4` : undefined}
        onComplete={menu ? onMenuStepComplete : undefined}
      />
    );
  }

  // ---- Level 3「2音まねっこ」(L3-1〜L3-3) ----
  if (screen === 'level3' && level3SessionRef.current) {
    return (
      <Level3Screen
        session={level3SessionRef.current}
        onBack={onLevel3Back}
        menuLabel={menu ? `メニュー ${menuIndex + 1}/4` : undefined}
        onComplete={menu ? onMenuStepComplete : undefined}
      />
    );
  }

  return null;
}
