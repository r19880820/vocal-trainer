# Training Model

トレーニング内容・採点・弱点特定・練習提案の仕様。
2026-08-16 Opus設計レビュー(C-5, C-6, M-8, M-9, M-11, m-13, m-14)とUX設計(UX_TRAINING.md)を反映済み。

## スキル体系(Exercise横断の履歴単位)

```text
pitchAccuracy / medianAbsCents / pitchStability / attackAccuracy /
intervalAccuracy / directionAccuracy
(将来: timingAccuracy, durationAccuracy, rangeLow, rangeHigh, ...)
```

Progress Tracking は Exercise 単位ではなく**この Skill 単位**で履歴を持つ(SkillSnapshot、paramsVersion付き)。

## MVPトレーニング(Level 1〜4)

### Level 1: 音の上下(相対音程の感覚)

- 2音再生(例: C4 → E4)。ユーザーが真似る
- 評価は**方向のみ**: 上がった / 下がった / 同じ(±50cent内)。絶対音程は問わない

### Level 2: 1音合わせ ← **最初の Playable MVP**

- 目標音を1音再生 → ユーザーが同じ高さで発声(「んー」でよい)
- リアルタイム表示: 低い←●→高い インジケータ(仕様は UX_TRAINING.md)
- 評価: pitchAccuracy / medianAbsCents / pitchStability / attackAccuracy / octaveOff
- 発声フェーズ: 上限5秒 or 発声後の連続無音500msで自動終了(仮値)

#### Level 2 状態遷移(ExerciseEngine)

| 状態 | 入りの処理 | 遷移条件 → 次状態 |
|---|---|---|
| idle | — | 開始操作 → checkPermission |
| checkPermission | マイク権限確認 | 許可済 → calibrating / 未許可 → 権限リクエスト / 拒否 → permissionDenied画面(設定誘導) |
| calibrating | 環境ノイズ測定500ms | 完了 → playingReference / ノイズ過大 → 「静かな場所で」案内 → idle |
| playingReference | お手本再生(明示的リリース付きエンベロープ) | 再生終了 +ガード250ms → listening |
| listening | 録音・リアルタイム表示開始 | onset検出 → phonating / 10秒無発声 → timeoutHint(「聞こえたら「んー」と…」)→ idle |
| phonating | リアルタイム表示継続 | 発声上限(spec.phonationMaxMs)→ scoring / 連続無音500ms → **有声合計 ≥ VALID_MIN_VOICED_MS(500ms)なら scoring。未満なら1回だけ listening へ戻し、2回目は scoring(tooShort)へ**(相槌1回は無視・短発声の繰り返しには「声を伸ばす長さ」の正しい案内 — レビューC-4/N-1) |
| scoring | 指標算出→WeaknessDetection→Recommendation | 完了 → result |
| result | 結果画面(UX_TRAINING.md) | もう一回 → playingReference / 次の練習 → 推奨ExerciseSpecで再スタート / 終了 → idle |
| (全状態) | — | キャンセル操作 → idle / バックグラウンド遷移・着信 → 録音破棄して idle(途中結果を採点しない) |

- お手本再生中にユーザーが歌い出した場合: listening 開始前の音声は計測対象外(回り込み対策のガード区間と同じ扱い)
- タイムアウト値等は AUDIO_ANALYSIS.md 定数表と同期

### Level 3: 2音模倣

- 例: C4 → G4
- 評価: First/Second Note Accuracy / intervalAccuracy / directionAccuracy / Transition Timing

### Level 4: 短いメロディ(3〜5音)

- 例: C4 → D4 → E4 → D4 → C4。お手本とユーザーの Pitch Curve を重ねて比較表示
- 同時再生比較には回り込み対策が必要(AUDIO_ANALYSIS.md §7、将来課題)

### 目標音の範囲

ユーザーの声域に合わせる(男声想定 C3〜C4、女声想定 A3〜A4 あたりから開始)。
MVPでは初回起動時に「低め/高め」選択で簡易対応(設定から変更可)。将来は Vocal Range 測定で自動化。

**目標音はハ長調スケール(ドレミファソラシ)上の音のみ**(2026-08-16 ユーザーフィードバック:
半音階(黒鍵)の目標は初心者の耳に不自然)。低め: ド3〜ラ3の6音 / 高め: ラ3〜ミ4の5音。
Training Recommendation が生成する目標(オクターブ寄せ・reachTarget・allGood)も
必ずスケール音へスナップする(core/pitch/scale.ts が正本)。

## Scoring → Weakness Detection(ルールベース)

```text
入力: ExerciseResult(validity, metrics, octaveOff) + 直近の Diagnosis / SkillSnapshot 履歴
処理:
  1. validity チェック — 無効なら弱点判定せず理由別に終了
     (tooShort=有声時間不足 / tooQuiet=音量・明瞭度不足。UXは理由別文言)
  2. octaveOff ≠ 0 なら弱点判定より優先し「オクターブ違い」を診断として返す
     (音の高さの感覚は合っている+1オクターブ下/上で歌っている、の専用文言)
  3. pitchAccuracy < REACH_TARGET_ACCURACY(0.05)なら専用ブランチ(**attack/stability の
     null 有無に依存しない** — 一瞬±50centをかすっただけで外れないように。レビューC-3):
     「まず目標音に到達すること」— 目標をユーザーの発声中央値に寄せた Level 2 変種を提案。
     ※ null を 0 として argmin に混ぜない(「音が取れない人に素早く合わせろ」と言う事故の防止)
  3b. 全指標が上級バンド → 弱点なし(rationale=allGood)。褒めのみ+次の音への挑戦を提案
     (弱点をでっち上げない。レビューm-8)
  4. 通常判定 — null でない指標のみを対象に、生値の argmin ではなく**参照バンド内順位**で決める。
     比較値は「正規化バンド内位置 = (value − バンド下限)/(バンド上限 − バンド下限)」
     (バンド下限からの生値距離で比較しない — rank0では生値argminに退化する。レビューM-2)
  5. ヒステリシス — 提案の切替は「同一 weakness が2セッション連続」または
     「バンドが1段以上明確に低い」ときのみ。僅差なら isReliable=false とし前回の提案を維持。
     前回参照は「**直近の primaryWeakness が非null の Diagnosis**」まで遡る
     (無効セッション1回でヒステリシスが消えないように。レビューM-3)
出力: Diagnosis { primaryWeakness | null, octaveOff, isReliable, rationale }
```

参照バンド(暫定・要較正):

| 指標 | 初級 | 中級 | 上級 |
|---|---|---|---|
| pitchAccuracy | <0.4 | 0.4–0.75 | >0.75 |
| pitchStability | <0.3 | 0.3–0.7 | >0.7 |
| attackAccuracy | <0.5 | 0.5–0.8 | >0.8 |

## Weakness → Training Recommendation(別モジュール)

| 診断 | 提案する練習 |
|---|---|
| octaveOff ≠ 0 | 同一 Level 2、目標音をユーザーの発声オクターブ側に寄せて再挑戦(文言も同方向 — UX §3.5b 裁定。「徐々に戻す」は将来実装) |
| 目標未到達(専用ブランチ) | 目標をユーザーの発声中央値に最も近い半音へ変更した Level 2 変種(=最も出しやすい高さ)/ Level 1(音の上下) |
| 弱点なし(allGood) | 少し違う高さ(+2半音程度)の新しい目標で Level 2 |
| pitchAccuracy 低 | Level 2: Single Note Matching(音域を狭めて) |
| pitchStability 低 | Level 2 のロングトーン変種(長く伸ばす) |
| attackAccuracy 低 | Level 2 変種: Pitch Attack Training(短音で素早く合わせる) |
| intervalAccuracy 低 | Level 3: Two Note Interval Training(Level 3実装後) |
| directionAccuracy 低 | Level 1: 音の上下(Level 1実装後) |

- **「次の練習」はテキスト表示ではなく、実際に起動できること**(推奨結果 = 実行可能な ExerciseSpec)。
  MVPでは「同一Exerciseをパラメータ違い(目標音・長さ)で再起動する」最小実装でループを閉じる
- **提案パラメータの制約(レビューM-4/M-5/N-2)**: 目標音は TARGET_MIDI_MIN〜MAX(48〜69)に、
  durationMs は DURATION_MIN〜MAX_MS(800〜4000ms)にクランプする(複利変化・検出可能域外への逸脱防止)。
  ただし**「ユーザーの声域側へ寄せる」提案(octaveOff / reachTarget)の下限のみ TOWARD_USER_MIDI_MIN(40=E2)**
  — 通常下限のままだと低い声のユーザーへの提案が同一specに空振りし文言と矛盾する。
  phonationMaxMs は ExerciseEngine が実際に参照する(定数への焼き込み禁止)
- Scoring / WeaknessDetection / TrainingRecommendation は**別モジュール**。将来 AI Coach に差し替えられるよう、入出力は構造化データのみ

## フィードバック原則

1. 結果画面で指摘は**1つだけ**(「次に直すこと」)
2. 専門用語を出さない。「-23 cents」ではなく「少し低いです ↑もう少し高く」
3. 詳細モードでのみ数値表示可
4. 文言・画面仕様の正本は [UX_TRAINING.md](UX_TRAINING.md)

## Progress Tracking

- Exercise 完了ごとに metrics を SkillSnapshot として保存(paramsVersion 付き)
- 進捗の主指標は連続量(medianAbsCents)— ±50cent二値は改善を捉えられない
- **MVPではメモリ内のみ。永続化は Storage ADR(Phase 7手前)まで実装しない**

## MVP受入条件(Playable MVP = Phase 3〜5 の縦切り)

1. お手本を聞く→発声→リアルタイム表示→終了→弱点1つ→**次の練習を実際に起動できる**、が一連で動く
2. **test-retest**: 同一ユーザーが連続3回同じ Exercise を行ったとき primaryWeakness が一致する
   (測定の再現性は「歌唱能力が実際に改善するのか」を検証する前提。割れているならUIを磨いても製品は成立しない)
3. 起動時セルフテスト(440Hz)とループバック遅延実測が合格(AUDIO_ANALYSIS.md)

## MVPでやらないもの(Do Not Implement)

市販楽曲解析 / 歌詞認識 / Vocal Separation / SNS / ランキング / 課金 /
クラウド同期 / AI Pitch判定 / AI声質診断 / ビブラート診断 / 高度な表現評価 /
interval・direction の算出実装(型のみ) / samples の永続化(Storage ADRまで)
