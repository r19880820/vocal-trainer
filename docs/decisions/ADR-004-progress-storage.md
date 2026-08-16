# ADR-004: Progress Tracking のストレージ

- Status: **Accepted**
- Date: 2026-08-16
- Decider: Fable

## Context

Phase 7(成長記録)で SkillSnapshot を端末に永続化する。データ量は極小
(1練習あたり数値4〜5個。毎日30回練習しても年間で数百KB)。クラウド同期はMVP対象外(Do Not Implement)。

## 検討した選択肢

| 選択肢 | 評価 |
|---|---|
| **localStorage(JSON)** | ◎ 同期API・実装最小・この規模(〜5MB上限)に十分。iOS Safariでも安定 |
| IndexedDB | △ 非同期・スキーマ管理のコスト。録音PCMなど大きいバイナリを保存する段になったら移行 |
| ファイル(File System Access API) | ✕ iOS Safari非対応 |

## Decision

**localStorage を採用。** キー `vt.progress.v1`(スキーマ変更時はキー番号を上げて移行)。

- 保存するのは validity=ok の結果のみ(無効測定で履歴を汚さない)
- SkillSnapshot(skillId / value / date ISO / exerciseId / paramsVersion)の追記配列
- **paramsVersion を必ず持たせ、バージョン跨ぎの数値比較を禁止**(AUDIO_ANALYSIS.md の較正で意味が変わるため)
- ストレージ実装は interface(getItem/setItem/removeItem)注入で抽象化 — テストはインメモリ、
  将来IndexedDBへ差し替え可能(ARCHITECTURE.md 原則3)
- 書き込み失敗(プライベートブラウズ等)は握りつぶして継続(練習体験を止めない)

## Consequences

- (+) 実装が最小。ExerciseResult.samples(波形系列)は保存しない方針もこれで自然に維持される
- (−) ブラウザデータ削除で履歴が消える → 将来エクスポート機能で緩和(バックログ)
- (−) 端末を跨げない(クラウド同期はDo Not Implement継続)
