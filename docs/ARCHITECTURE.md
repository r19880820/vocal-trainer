# Architecture

2026-08-16 Opus設計レビュー反映済み。同日 ADR-003(Web-first)によりターゲットを iOS Safari向けWebアプリ(TypeScript)へ転換 — **層構造・データ型・依存ルールは不変**、実行環境のみ変更。

## 設計原則

1. **層の分離** — 音声処理・評価・提案・UIを独立モジュールにする。UIから直接DSPを呼ばない
2. **core は純 TypeScript** — DOM / Web Audio / React に依存しない。全ロジックが Vitest で単体テスト可能
3. **境界はインターフェース** — PitchDetector / AudioCapture / Storage / AICoach は差し替え可能な interface
4. **Raw と Processed の分離** — 生のピッチ検出結果と後処理済み結果を別型で持つ
5. **処理層は目標非依存** — PitchProcessor は Exercise の目標音を知らない。目標との差(cents)は features/scoring 層で算出する
6. **Score と診断の分離** — 内部は常に構造化データ。表示用スコアは末端で導出する
7. **AI Coach は境界だけ先に切る** — MVPでは未実装。ただし入出力型は最初から定義する

## モジュール構成

```text
src/
  core/                    # 純 TypeScript。DOM/Web API の import 禁止
    types.ts               # 中核データ型(下記)
    constants.ts           # 名前付き定数(AUDIO_ANALYSIS.md §8 と同期)
    audio/                 # ハーフバンド÷2デシメータ等の純DSPユーティリティ
    pitch/                 # PitchDetector interface + YIN 実装、Hz/MIDI/cent変換
    processing/            # PitchProcessor: DC除去/HPF, 相対silence gate,
                           #   voicing判定, octave fix(単発のみ), median, 表示用EMA
    features/              # TargetTrack突き合わせ・cents算出・セグメント分割・統計量
    scoring/               # 指標算出 → ExerciseResult(構造化)
    diagnosis/             # WeaknessDetection: ルールベース
    training/              # TrainingRecommendation: 弱点→練習マッピング
    exercise/              # ExerciseEngine: 状態機械(調整役。上位層として他coreを使う)
    progress/              # ProgressTracking: Skill単位の履歴
    coach/                 # AICoach interface(MVP未実装、型定義のみ)
  platform/                # Web実装: getUserMedia/AudioContext/AudioWorklet捕捉、
                           #   pitch-worker(Web Worker)、お手本音の生成・再生
  data/                    # Storage 実装(localStorage/IndexedDB — Phase 7 ADR)
  ui/                      # React 画面・リアルタイムPitchインジケータ
```

## データフローとスレッドモデル

```text
platform/ getUserMedia(EC/NS/AGC=false 要求) + AudioContext
    │
[AudioWorklet]  128フレームブロックを蓄積(~512フレーム単位でpostMessage、transfer)
    │            ※worklet内は最小限。DSPを置かない
    ▼
[Web Worker(pitch-worker)]
  ハーフバンド÷2デシメート → 内部レート(実レート÷2、iOSは通常24kHz)
  hop(256サンプル)組み立て
  Pitch Detection (YIN)      → RawPitchSample
  Pitch Processing           → ProcessedPitchSample
    │  確定サンプルのみメインへ postMessage
    ▼
[メインスレッド]
  UI(リアルタイム表示: ForDisplay 系列、60fps)
  Feature Extraction         → TargetTrack と突き合わせ(cents算出)
  Scoring                    → ExerciseResult
  Weakness Detection         → Diagnosis
  Training Recommendation    → RecommendedExercise(実行可能な ExerciseSpec)
  Progress Tracking          → SkillSnapshot 履歴
```

- YIN+処理層をメインスレッドで回すと60fps描画予算(16.6ms)を圧迫するため、**DSPはWeb Workerで実行**
- `core/` は Worker/メインどちらでも動く(DOM非依存)。**中核データ型は structured clone / transfer 可能な単純型のみ**で構成
- 音声開始は必ずユーザー操作起点(ブラウザの自動再生制限)。AudioContext.resume() をタップハンドラ内で呼ぶ

## 中核データ型

```text
RawPitchSample {
  sampleIndex        // 録音ストリームのサンプル位置(内部レート基準)。壁時計時刻の代入禁止
  timestampMs        // sampleIndex から導出
  frequencyHz        // 0 = 候補なし
  belowThreshold     // YIN絶対閾値を通過したか。voicing判定の一次情報
  confidence         // 0..1(clamp済)。スケールは検出器固有 — 検出器間で比較不能。
                     //   処理層に固定閾値を置かない(gate定数は検出器実装が公開する)
  amplitude          // RMS(ホップ単位、DC除去後)
}

ProcessedPitchSample {
  sampleIndex, timestampMs
  frequencyHzForScoring   // median後・EMA前。採点はこちら
  frequencyHzForDisplay   // EMA後(centドメイン)。表示専用
  midiNote                // ForScoring から導出、実数
  voicing                 // 'voiced' | 'silent' | 'tooQuiet' | 'unclear'
}
// 注: 目標とのcents差は持たない(処理層は目標非依存 — 原則5)

TargetNote { midiNote, startMs, durationMs }

ExerciseSpec {
  exerciseId, levelId
  targets: TargetNote[]        // MVP(Level 2)は1要素。Level 3/4 でそのまま伸びる
  phonationMaxMs, guardAfterPlaybackMs   // フロー定数(AUDIO_ANALYSIS.md 定数表)
}

ExerciseResult {
  spec                // 実施時の ExerciseSpec スナップショット(過去結果を後から再解釈可能に)
  timestamp
  paramsVersion       // 指標算出パラメータのバージョン。バージョン跨ぎの履歴比較禁止
  validity: { isValid, reason }   // reason: 'ok' | 'tooShort' | 'tooQuiet'
  metrics: {
    pitchAccuracy       // 0..1
    medianAbsCents      // 連続量(履歴・進捗用)
    pitchStability      // number | null(null = 測定不能。0にしない)
    attackAccuracy      // number | null(null = 測定不能。0にしない)
    intervalAccuracy    // 型のみ。Level 3 まで算出しない
    directionAccuracy   // 型のみ。Level 1 まで算出しない
    timingAccuracy / durationAccuracy   // 将来(Phase 8)
  }
  octaveOff           // -1 | 0 | +1(持続的オクターブ差の診断。処理層で補正しない)
  samples: ProcessedPitchSample[]   // MVPはメモリ内のみ。永続化は Storage ADR まで禁止
}

Diagnosis {
  primaryWeakness     // metrics のキー1つ、または null(判定保留)
  octaveOff           // ±1 のときは弱点より優先して専用文言(TRAINING_MODEL.md)
  isReliable          // 僅差判定時 false → 前回の提案を維持(ヒステリシス)
  rationale           // ルールID(将来AIの説明素材)
}

SkillSnapshot {
  skillId, value, date, exerciseId, paramsVersion
}
```

## PitchDetector interface(ストリーム型)

```typescript
interface PitchDetector {
  reset(): void;
  push(hop: Float32Array): RawPitchSample | null;  // 出力確定時に返す(遅延出力を許容)
  flush(): RawPitchSample[];                       // 系列末尾の残りを吐き出す
}
```

- YIN: 状態なし、push即返し(バッファ充足後)
- pYIN: 内部にViterbi窓を持ち遅れて返す — **同一契約で差し替え可能**

## 依存ルール

- `core/` 内は**一方向順序**を厳守(逆流・循環禁止):
  `audio < pitch < processing < features < scoring < diagnosis < training`
  `exercise` は調整役として上位から各公開APIを使う。`progress` は scoring の型に依存
- `core/` で DOM / Web Audio / React / `window` / `document` を import・参照しない
- `ui/` → `core/` の公開APIのみ。DSP実装に触らない
- `platform/` → `core/audio`・`core/pitch` を利用する側。**AudioContext.sampleRate /
  MediaStreamTrack.getSettings() の実パラメータ読み戻しを必須**とする
- `data/` → `core/` を参照可。**逆は禁止**(core は Storage 実装を知らない)
- `core/coach/` の入力は **ExerciseResult / Diagnosis / SkillSnapshot 履歴のみ**。生音声・生ピッチをAIに渡さない

## 未確定事項(ADR待ち)

- ストレージ実装(localStorage で十分か、IndexedDB か) → Phase 7 手前で ADR-004
- 公開ホスティング先(GitHub Pages / Vercel 等) → tasks/decisions.md Q4
- DTW等の時間伸縮比較(Phase 9)の置き場所 → features/ 配下を想定
- Level 4 の同時再生比較における「お手本音の回り込み検出」方式(お手本F0既知を利用)
