# Product Vision

## 一言で

> 歌が苦手な人が、自分の弱点を理解し、適切な練習を行い、実際に歌唱能力を向上させられる「パーソナル歌唱トレーナー」

採点アプリではない。**上達アプリ**である。

## 既存カラオケ採点との違い

| 既存採点 | 本アプリ |
|---|---|
| 「78点」で終わる | 「次に何を練習すべきか」を示す |
| 結果の提示 | 診断 → 練習 → 改善確認のループ |
| 上手い/下手の判定 | 弱点の特定と改善手段の提示 |

## 中心ループ(トレーニングループ)

```text
Assessment(診断)
    ↓
Weakness Detection(弱点特定)
    ↓
Training Recommendation(練習提案)
    ↓
Exercise(練習)
    ↓
Measurement(測定)
    ↓
Progress Evaluation(成長確認)
    ↓
次の Training Recommendation
```

Scoring だけで終わらせない。これが全設計判断の基準。

## 最終的に育成したい能力(スキル体系)

- **Pitch** — 絶対/相対音程、音程移動、安定性、音の入り、高低音での精度
- **Rhythm** — 歌い出し、音符の長さ、走り/遅れ、フレーズ全体のタイミング
- **Voice Stability** — ロングトーン、ピッチ揺れ、声量の安定、息の継続
- **Vocal Range** — 無理なく出せる最低/最高音、実用音域
- **Phrase Reproduction** — お手本との Pitch / Rhythm / Duration / Dynamics 比較
- **Expression**(将来) — 強弱、語尾、アクセント、フレージング。AIなしで信頼性高く判定できない項目は無理に数値化しない

## AIと機械判定の役割分担

```text
Measurement(決定論的・ローカル)
     ↓
Rule-based Analysis
     ↓
Structured Result(構造化データ)
     ↓
AI Coach(解釈・説明・メニュー生成)
```

- 音声から客観測定できるもの(Pitch / Rhythm / Stability / Interval 等)は**決定論的アルゴリズム**で判定
- AI は診断結果の説明・練習メニュー生成・長期計画・コーチングに使う
- **AIがPitchそのものを判定する構造にはしない**

## 最重要ルール

> この実装によってユーザーの歌唱能力が実際に改善するのか?

- 「測れるから測る」は禁止
- 「AIでできそうだから入れる」は禁止
- 縦切り(聞く→発声→リアルタイム表示→弱点→次の練習)の完成まで機能を広げない

## 現在の最優先ゴール(Playable MVP)

> お手本の音を聞く
> ↓ 自分で発声する
> ↓ リアルタイムでズレが分かる
> ↓ 終了すると弱点が分かる
> ↓ 次に何を練習すればいいか分かる

詳細な MVP スコープは [TRAINING_MODEL.md](TRAINING_MODEL.md) と [../AGENTS.md](../AGENTS.md) を参照。
