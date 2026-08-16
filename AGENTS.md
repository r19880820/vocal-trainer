# AGENTS.md — 全AI共通の作業前提

本リポジトリで作業する全AI(Fable / Opus / Sonnet / Codex)はまずこのファイルを読むこと。
**リポジトリが正本**。会話履歴上の合意より、ここと docs/ の記載が優先する。

## Product Vision(要約)

採点アプリではなく**上達アプリ**。「診断 → 弱点特定 → 練習提案 → 練習 → 再診断」のループで
歌が苦手な人の歌唱能力を実際に改善する。詳細: [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md)

判断基準は常に一つ:
> この実装によってユーザーの歌唱能力が実際に改善するのか?

## Architecture Principles

- core(音声処理・採点・診断・提案)は**純 Dart**、Flutter依存禁止、全て単体テスト可能に
- Raw Pitch と Processed Pitch を分離。Score と構造化診断データを分離
- Scoring / WeaknessDetection / TrainingRecommendation は別モジュール
- AI は測定をしない。AI Coach の入力は構造化データのみ(interface だけ先に定義、MVP未実装)
- 詳細: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) / [docs/AUDIO_ANALYSIS.md](docs/AUDIO_ANALYSIS.md)

## Important Decisions(ADR)

| ADR | 決定 | Status |
|---|---|---|
| [ADR-001](docs/decisions/ADR-001-pitch-detection.md) | Pitch Detection = YIN 自前実装(ストリーム型interface、内部レート=実レート÷2) | **Accepted** |
| [ADR-002](docs/decisions/ADR-002-mobile-framework.md) | Framework = Flutter | Superseded(ADR-003) |
| [ADR-003](docs/decisions/ADR-003-web-first-ios.md) | **iOS Safari向けWebアプリ**(TypeScript+Vite+React、AudioWorklet+Web Worker。iPhone実機PoC=Phase 0.5、較正はiPhoneのみ) | **Accepted** |

決定の変更は必ずADR更新で行う。「以前のAIがそう言っていた」は根拠にならない。

## Current MVP Scope

**Level 2「1音合わせ」の縦切り(= Phase 3〜5 の3フェーズで1マイルストーン)**が最初のPlayable MVP:
お手本1音再生 → 発声 → リアルタイム差表示 → 音程軌跡 → 機械的評価 → 改善ポイント1つ表示 →
**次の練習を実際に起動できる**。受入条件に test-retest(連続3回で診断一致)を含む。
Level定義・採点・提案ルール: [docs/TRAINING_MODEL.md](docs/TRAINING_MODEL.md)

## Do Not Implement(MVP期間中)

市販楽曲解析 / 歌詞認識 / Vocal Separation / SNS / ランキング / 課金 / クラウド同期 /
AI Pitch判定 / AI声質診断 / ビブラート診断 / 高度な表現評価。
「測れるから測る」「AIでできそうだから入れる」は禁止。

## Coding Rules

- 言語: TypeScript(strict)。UI = React、ビルド = Vite
- `src/core/` は DOM / Web Audio / React / window / document の import・参照禁止(純TS)
- 命名・型は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) の中核データ型に従う
- マジックナンバー(閾値等)は `src/core/constants.ts` に集約し、AUDIO_ANALYSIS.md §8 と同期させる
- UI文言は [docs/UX_TRAINING.md](docs/UX_TRAINING.md) を正本とする(専門用語をユーザーに見せない)
- 既存ファイルの上書き前に必ず現状を読む。同一ファイルを複数AIが同時編集しない

## Testing Rules

- core の全モジュールに単体テスト必須(Vitest、`npm run test`)。特に:
  - 変換式(Hz→MIDI→cent)は既知値でテーブルテスト
  - YIN は合成波形(サイン波・倍音付き・ノイズ混入)の **F0スイープ80〜700Hz** で全帯域±10cent検証
  - Scoring は合成 PitchSample 列(理想/遅い入り/不安定/オクターブ違い/目標未到達/小声等)でテスト
  - WeaknessDetection / Recommendation はルール表どおりの全分岐テスト(null指標・専用ブランチ含む)
- 実録音の回帰: 録音再生ハーネス(Phase 1先頭で構築)で同一録音を再投入して検証する。
  音響パラメータの較正は iPhone 実機のみ(デスクトップブラウザ実測から採用しない — ADR-003)
- 「完了」はテスト実行の証跡があるものだけ。失敗は失敗として報告する

## AI Role Separation

| AI | 役割 |
|---|---|
| Fable | オーケストレーション、タスク分解・割当、成果物統合、最終判断 |
| Opus | アーキテクチャ・アルゴリズム設計、設計レビュー、難バグ解析 |
| Sonnet | 中規模実装、調査、ドキュメント、UX文言、PRレビュー |
| Codex | 仕様確定後の実装、テスト実装、ビルド/lint修正、機械的リファクタ |

- 重要な変更は「作るAI」と「レビューするAI」を分ける(自作自認の禁止)
- 依存のないタスクは並列化する。ただし同一ファイルの同時編集は禁止

## Task Management

- **現在地・全体像: [docs/ROADMAP.md](docs/ROADMAP.md)**(フェーズ進捗の正本)
- 進行中タスク: [tasks/current.md](tasks/current.md)
- バックログ(Phase別): [tasks/backlog.md](tasks/backlog.md)
- 決定ログ・未確定事項: [tasks/decisions.md](tasks/decisions.md)

タスクの着手・完了時は tasks/current.md を、フェーズの進捗が変わったら ROADMAP.md を更新すること。
