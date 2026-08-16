# Decisions Log

正式な決定は docs/decisions/ の ADR が正本。ここは時系列ログと未確定事項の一覧。

## 決定ログ

| 日付 | 内容 | 根拠 |
|---|---|---|
| 2026-08-16 | Pitch Detection = YIN 自前実装(**Accepted** — Opusレビュー条件5点反映済) | [ADR-001](../docs/decisions/ADR-001-pitch-detection.md) |
| 2026-08-16 | Framework = Flutter(Proposed — **Q3確定までAccepted保留**)。検証順序はAndroid実機リスク先頭(Phase 0.5)、Windowsはロジック反復専用・較正禁止 | [ADR-002](../docs/decisions/ADR-002-mobile-framework.md) |
| 2026-08-16 | Opus設計レビュー(Critical 8/Major 11/Minor 14)を全docsに反映。主要変更: 内部レート÷2化・voicing4値・octaveOff一級診断・null指標・バンド順位+ヒステリシス・Phase0.5新設・MVP=Phase3〜5 | [current.md](current.md) 参照 |
| 2026-08-16 | **Web-first転換(ユーザー指示)**: ユーザー端末=iPhone・Webアプリ希望 → iOS Safari向けWebアプリ(TS+Vite+React)。ADR-002 Superseded。Phase 0.5はiPhone Safari PoCに変更 | [ADR-003](../docs/decisions/ADR-003-web-first-ios.md) |
| 2026-08-16 | リポジトリを `C:\dev\vocal-trainer` へ移設(Q1ユーザー承認) | Q1 CLOSED |
| 2026-08-16 | core は純 Dart・AI Coach は境界のみ先行定義 | [ARCHITECTURE.md](../docs/ARCHITECTURE.md) |
| 2026-08-16 | MVP = Level 2「1音合わせ」縦切り | [TRAINING_MODEL.md](../docs/TRAINING_MODEL.md) |

## 未確定事項(ユーザー判断待ち)

| # | 論点 | 推奨 | 状態 |
|---|---|---|---|
| Q1 | プロジェクト置き場 | `C:\dev\vocal-trainer` へ移設 | **CLOSED**(承認・移設済 2026-08-16) |
| Q2 | 環境セットアップ実施者 | Web-first化でNodeのみ(導入済)。AI実施 | **CLOSED**(2026-08-16) |
| Q3 | Android実機の有無 | 不要になった(iPhone+Webアプリ) | **CLOSED**(ADR-003で無効化) |
| Q4 | 公開ホスティング先 | **GitHub Pages 採用・稼働中**: https://r19880820.github.io/vocal-trainer/(公開リポジトリ https://github.com/r19880820/vocal-trainer、mainへのpushでテスト全緑→自動デプロイ) | **CLOSED**(2026-08-16 ユーザーのアカウント提供により実施) |

## 未確定事項(技術・後続ADR予定)

- ストレージ実装(ローカルJSON vs sqlite系)→ Phase 7 手前で ADR-003
- 閾値較正(±50cent、confidence 0.6、UXゾーン境界±100cent、発声5秒/無音500ms 等)→ Phase 1 実測後に AUDIO_ANALYSIS.md / UX_TRAINING.md を同期更新
