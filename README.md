# Vocal Trainer(仮称)

歌が苦手な人が、自分の弱点を理解し、適切な練習で実際に歌唱能力を向上させる
**パーソナル歌唱トレーナー**アプリ。

- **現在地・全体像: [docs/ROADMAP.md](docs/ROADMAP.md)** ← 「今どこまで出来てるか」はまずここ
- プロダクトビジョン: [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md)
- アーキテクチャ: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 音声解析仕様: [docs/AUDIO_ANALYSIS.md](docs/AUDIO_ANALYSIS.md)
- トレーニング仕様: [docs/TRAINING_MODEL.md](docs/TRAINING_MODEL.md)
- 技術決定(ADR): [docs/decisions/](docs/decisions/)
- タスク: [tasks/current.md](tasks/current.md) / [tasks/backlog.md](tasks/backlog.md)

## AIで開発する場合

作業前に必ず [AGENTS.md](AGENTS.md) を読むこと。リポジトリが正本。

## 現在の状態(詳細は docs/ROADMAP.md)

**iOS Safari 向け Web アプリ**(TypeScript + Vite + React、ADR-003)。
Playable MVP(Level 2「1音合わせ」: お手本→発声→リアルタイム表示→弱点1つ→次の練習)は
**実装完了・較正前** — 動くが判定閾値は仮値で、iPhone実機較正とtest-retest受入が残っている。

- **本番URL(GitHub Pages)**: https://r19880820.github.io/vocal-trainer/(mainへのpushで自動デプロイ、テスト全緑が条件)
- 開発: `npm install` → `npm run dev`(HTTPS)。iPhoneから同一Wi-Fiで `https://<PCのIP>:5173`
- テスト: `npm run test` / デバッグ・較正ツール: URL末尾に `?debug`
