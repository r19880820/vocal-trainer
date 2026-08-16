# Audio Analysis

音声取得からピッチ測定・指標算出までの技術仕様。決定は [decisions/ADR-001-pitch-detection.md](decisions/ADR-001-pitch-detection.md) を正本とする。
2026-08-16 Opus設計レビューの指摘(C-2〜C-7, M-1〜M-10, m-1〜m-8)を反映済み。

## 1. Audio Capture

実行環境は Web Audio API(ADR-003: iOS Safari向けWebアプリ)。

| 項目 | 値 | 理由 |
|---|---|---|
| 実サンプリングレート | `AudioContext.sampleRate` の実値(iOS Safariは通常48kHz、デスクトップは44.1k/48k) | ブラウザ/端末が決める。要求は保証されない |
| **実レートの契約** | `AudioContext.sampleRate` と `MediaStreamTrack.getSettings()` を必ず読み戻し、リサンプル係数・τ範囲をそこから導出。定数焼き込み禁止 | 不一致を放置すると全ピッチが無警告でずれる(YINはエラーを出さずそれらしい値を出し続ける) |
| 内部レート | **実レート ÷ 2**(24kHz / 22.05kHz)。ハーフバンドFIR+間引きのみサポート | ÷2は正しく実装できる(441:160等の有理リサンプル自前実装は事故源)。16kHzではτ量子化が粗く±10cent目標が原理的に未達(440Hzで格子幅47cent) |
| 想定外レート | fail-loud(エラー表面化)。無言でそれらしい値を出さない | 同上 |
| チャンネル / フォーマット | mono / float32(Web Audioネイティブ) | |
| 積分窓 W | 1024 samples(42.7ms @24k) | 不変条件 **W ≥ 2·τ_max** をテストで保証(2·400=800 ≤ 1024) |
| バッファ長 N | **N = W + τ_max ≈ 1424 samples(59ms @24k)** | YINの差分関数は W+τ のサンプルを要する。WとNを混同しない |
| ホップ長 | 256 samples(10.7ms @24k、更新 ~94Hz) | 60fps UIに十分 |

- ブラウザの音声前処理は getUserMedia constraints で**無効化を要求**する:
  `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`。
  **要求が実際に適用されたかを `MediaStreamTrack.getSettings()` で読み戻して確認**する。
  **実機確認済(2026-08-16 ユーザーiPhone)**: sampleRate=48000 / echoCancellation=false適用 /
  NS・AGCはキー非報告=制御不可の可能性(相対gate設計で吸収、較正で実害確認 — ADR-003)
- 音声開始(AudioContext.resume / getUserMedia)は必ずユーザー操作(タップ)起点
- **較正はiPhone実機のみ**。デスクトップブラウザ(Windows)はロジック開発専用とし、音響パラメータの較正値を採用しない(ADR-003)
- **起動時セルフテスト**: 440Hzトーンを自機スピーカーで再生→自機マイクで録音→検出値440±20Hzを確認する診断モードをPhase 1に実装。レート契約違反・チャネル誤解釈・リサンプルバグを一括検出する。
  **実機PASS(2026-08-16 ユーザーiPhone): 実測439.5Hz(誤差≈2cent)** — 全チェーン(スピーカー→マイク→worklet→÷2→HPF→YIN→処理層)がiPhone上で検証済み

## 2. Pitch Detection(YIN)

- アルゴリズム: **YIN**(difference function + CMNDF + 絶対閾値 + 放物線補間)
- 探索範囲: **60〜700Hz(MVP)**。歌唱ターゲット帯はC3〜A4(130〜440Hz)。
  **下限60Hzは「目標C3を1オクターブ下(65Hz)で歌う」誤りを検出するため**(80Hz下限だと
  τが上限に張り付き常に80Hzと誤報告され、octaveOff診断が構造的に不可能+voicing=unclearで
  「聞こえません」ループになる — レビューC-1)。上限を広げてもオクターブ誤検出面積が増えるだけ
- τ範囲: 実レートから導出(24kHzで約34〜400、22.05kHzで約31〜367)
- **τ張り付きのfail-loud**: 採用τが τ_max−1 以上(=探索下限未満のF0の可能性)なら
  belowThreshold=false とし、それらしい値を無言で出さない(§1の契約と同旨)
- **絶対閾値ステップ(YIN原典)**: CMNDF が閾値0.15を下回る**最初の**τを採用。存在しなければ大域最小を採用し `belowThreshold=false` を立てる
- **放物線補間はτドメインで行い**、f = fs_internal / τ̂(周波数にしてから補間しない — 短ラグで系統誤差)。原典step 6(best local estimate)は初期実装では省略可、省略した事実をコードコメントに残す
- confidence = **clamp(1 − CMNDF(τ̂), 0, 1)**(CMNDFは1を超え得る。特に発声立ち上がりで超えるため clamp 必須)。
  **confidenceのスケールは検出器固有**であり検出器間で比較不能。voicing判定の一次情報は `belowThreshold` を使う(confidenceに対する第二の固定閾値は置かない)
- CPU見積: 約324k MAC/hop ≈ 20〜30M MAC/s。TypeScript + Float32Array(Web Worker実行)で1コアの数%。不足が実測されたらWASM化
- 出力: RawPitchSample(候補なしは frequencyHz=0)

実装上の確定事項(2026-08-16 実装時の判断。コード=src/core/pitch/yin.ts と同期):

- **完全無音(解析域が定数信号)の特例**: このときのみ frequencyHz=0 / confidence=0。それ以外は belowThreshold=false でも大域最小からの推定値を frequencyHz に入れる
- **ゼロ除算ガード**: CMNDF の分母(d の累積和)が0のとき d'(τ)=1(YIN実装慣行)
- **confidence は補間前の整数τにおける d' を使用**(τ̂での再評価はしない。実装慣行)
- **d/CMNDF は τ=0..tauMax の全域で計算する**(tauMin 未満も含む)。F0_MAX 境界(700Hz)の放物線補間精度がこれに依存するため、**τ計算範囲を tauMin 以降に縮める最適化は禁止**(スイープテストが割れる)
- デシメータは窓関数sinc FIR 63タップ(厳密なハーフバンド構造ではない — 演算半減の最適化余地としてメモ。精度への影響なし)

選定理由・比較(pYIN / MPM / ACF)は ADR-001 参照。`PitchDetector` は**状態を持つストリーム型 interface**(reset / push / flush)とし、pYIN(内部Viterbi窓)へも同一契約で差し替え可能にする(ARCHITECTURE.md参照)。

## 3. Pitch Processing(Raw → Processed)

順序どおりに適用する:

0. **DC除去 + ハイパス** — フレーム毎の平均値除去 + 1次HPF 50Hz(探索下限80Hzより下)。**RMSはDC除去後に計測**(息の吹かれ・手持ちノイズがgateを誤通過するのを防ぐ)
1. **Silence gate(相対閾値)** — Exercise開始前に**500msの環境ノイズ測定**を行い、gate = ノイズフロア +12dB(絶対下限 **-62dBFS**、2026-08-16 iPhone実測で-55から較正: AGC無効のiPhoneは小声が-53〜-56dBFSに分布)。絶対dBFS固定は禁止(AGC無効化により端末間ゲイン差20dB超。小声の初心者=本アプリのど真ん中を締め出す)。ノイズフロアが高すぎる場合は「静かな場所で」をUXで案内
2. **Voicing判定** — 結果は4値enum:
   - `silent`: RMSがノイズフロア近傍
   - `tooQuiet`: RMSがgate未満(だが無音ではない)
   - `unclear`: RMSは十分だが `belowThreshold=false`(ささやき/息漏れ声)
   - `voiced`: 上記以外
3. **Octave error補正** — **単発(1〜2フレーム)で元の高さに戻る跳躍のみ**補正。基準は「直前サンプル」ではなく**直近300msの有声中央値**(最初の誤検出に以降がロックされるアンカー汚染を防ぐ)。
   **持続的なオクターブ差は補正しない** — ユーザーが本当に1オクターブ外して歌っているのは最頻出・最重要の診断結果であり、Scoring層に `octaveOff` として届ける(TRAINING_MODEL.md参照)
4. **Median filter** — 直近5サンプル。単発外れ値除去
5. **表示用 smoothing** — EMA(α≈0.3)。**必ずcent/MIDI(対数)ドメインで適用**(HzドメインのEMAは高域にバイアスする。medianは単調変換不変なのでどちらでも同値)

**Scoringはstep 4の出力(median後・EMA前)を使用。step 5はUI表示専用。** ProcessedPitchSample は `frequencyHzForScoring` / `frequencyHzForDisplay` を別フィールドで持つ。

**目標とのcents差は処理層では計算しない。** 処理層は目標非依存とし、features/scoring層で TargetTrack と突き合わせて算出する(Level 3/4の時間変化する目標に型変更なしで対応)。

## 4. 変換式

```text
midi  = 69 + 12 * log2(hz / 440)
cents = 1200 * log2(userHz / targetHz)   // features/scoring層で算出
```

## 5. 評価指標の定義(MVP)

- **発声開始(onset)** = voicing==voiced が連続150ms以上続いた最初の連続区間の**先頭時刻**(遡及。150ms経過時点ではない)
- UX文言の「最初の音に入るまでX秒」の起点はこのonset(合図やお手本終了時点ではない)

| 指標 | 定義 | 正規化 | 測定不能条件 |
|---|---|---|---|
| pitchAccuracy | 有声時間のうち \|cents\| ≤ 50 だった割合 | 0..1 | 有声時間不足(→validity) |
| medianAbsCents | 有声区間の \|cents\| 中央値。**履歴記録・進捗表示用の連続量**(±50cent二値は80→55centの改善を捉えられない) | 生値(cent) | 同上 |
| pitchStability | 目標到達後の安定区間における cents 標準偏差 σ → clamp(1 − σ/100, 0, 1) | 0..1 | **目標未到達なら null**。**到達後の有声時間 < STABILITY_MIN_MS(300ms)も null**(1サンプルでσ=0→「とても安定」誤褒めの防止 — レビューC-2) |
| attackAccuracy | onset → 初めて \|cents\| ≤ 50 に入るまでの時間 t → clamp(1 − t/2.0s, 0, 1) | 0..1 | **一度も到達しなければ null**(0にしない) |
| octaveOff | 有声時間の過半で \|cents ∓ 1200\| ≤ 100 に集中 → ±1(通常は0) | -1/0/+1 | — |
| directionAccuracy / intervalAccuracy | **型定義のみ。Level 1/3実装まで算出しない** | — | — |

- null(測定不能)は0と厳密に区別する。WeaknessDetectionはnullでない指標のみを比較対象にする(TRAINING_MODEL.md)
- validity判定(レビューM-1で再設計): **(1)** voicedMs ≥ VALID_MIN_VOICED_MS → ok。
  **(2)** それ未満で、active区間(最初〜最後の非silentサンプル)内の tooQuiet+unclear 時間 ≥ VALID_MIN_VOICED_MS → tooQuiet。**(3)** それ以外 → tooShort。
  分母を録音全体にしない(発声前の待ち時間で判定が変わり test-retest を壊すため)。TOO_QUIET_DOMINANT_RATIO は廃止
- pitchAccuracy / octaveOff は**時間重み付き**(サンプル数比ではない)。octaveOff ≠ 0 のとき pitchAccuracy系4指標は**オクターブ補正後のcents**で算出する(「高さの感覚は合っている」を正しく評価)
- σは75%オーバーラップした系列から算出される(実効独立サンプル数は名目の約1/4)。ホップ/窓長を変えるとσの意味が変わるため、**ExerciseResult / SkillSnapshot に paramsVersion を持たせ**、バージョン跨ぎの履歴比較を禁止する
- ±50cent・正規化定数は仮値。較正はiPhone実機で行う(デスクトップブラウザ不可)。変更時は本ファイルと定数表を同期更新

## 6. レイテンシ予算

リアルタイムインジケータは「表示を見て声を直す」**閉ループ制御**。遅延が大きいとユーザーはオーバーシュートしてハンチングし、アプリのせいでpitchStabilityが悪化して誤診断される。

| 要素 | 遅延見積 |
|---|---|
| 解析窓の中心(46ms窓) | ~23ms |
| median 5点(因果) | ~29ms |
| EMA α=0.3(表示のみ) | ~30ms |
| キャプチャバッファ+プラグイン層 | 20〜100ms(実測要) |
| 描画 | ~17ms |
| 合計見積 | **120〜200ms** |

- **目標: 表示遅延 ≤ 100ms**
- Phase 1受入項目: **ループバック実測**(クリック音再生→自機録音→検出時刻差)。「処理時間 < ホップ11.6ms」は**スループット条件**であり遅延条件ではない — 両方を別々に測る
- **実測(2026-08-16 ユーザーiPhone)**: ループバック中央値 **84ms** = 出力+入力+検出の合計。
  表の「キャプチャ20〜100ms(実測要)」の不確定幅を実測で確定(入力側は≤84ms)。
  表示経路の総遅延は これの入力側成分+処理遅延(窓中心/median/EMA/描画 ≈90ms)で、
  体感で問題が出た場合のみ下記ノブで調整する
- 予算超過時の調整ノブ: median 5→3、EMA α引き上げ、ホップ短縮、キャプチャバッファ縮小

## 7. 既知のリスクと対策方針

- **お手本音の回り込み** — OS前処理無効化の直接の帰結としてAECが働かない。お手本再生がマイクに入るとYINは「お手本を検出して完璧」と表示する。対策: (1) **イヤホン推奨をUXフローに組込み**(未装着時は注意表示)、(2) 再生終了後**200〜300msのガード区間**を置いてから計測開始、(3) お手本音のエンベロープに明示的リリース(残響を残さない)。Level 4の同時再生比較は将来課題(お手本F0既知を利用した回り込み検出を未確定事項に登録済み)
- **ささやき/息漏れ声** — voicing=unclear として検出し、理由別のフィードバック文言を出す(UX_TRAINING.md)。誤った数値を出さない
- **端末マイク差** — 相対gate(§3-1)+起動時セルフテスト(§1)で吸収
- **背景ノイズ** — MVPでは静かな環境前提+ノイズフロア測定で案内。頑健化はMVP外
- **タイムスタンプ** — 全サンプルは `sampleIndex`(録音ストリーム基準)を一級で持ち、msは導出値。壁時計を混ぜない(Phase 8リズム評価の前提)

## 8. 定数表(named constants — コードと同期させる正本)

| 定数 | 値 | 状態 |
|---|---|---|
| INTERNAL_RATE_DIVISOR | 2 | 確定 |
| YIN_WINDOW (W) | 1024 | 確定(W ≥ 2·τ_max) |
| YIN_HOP | 256 | 確定 |
| F0_MIN / F0_MAX | 60 / 700 Hz | 確定(MVP。下限60=1オクターブ下歌唱の検出用) |
| STABILITY_MIN_MS | 300 | 仮 |
| REACH_TARGET_ACCURACY | 0.05 | 仮 |
| TARGET_MIDI_MIN / MAX | 48 / 69 | 仮(提案クランプ) |
| TOWARD_USER_MIDI_MIN | 40 | 仮(声域側へ寄せる提案専用の下限 — レビューN-2) |
| DURATION_MIN / MAX_MS | 800 / 4000 | 仮(提案クランプ) |
| YIN_THRESHOLD | 0.15 | 仮 |
| HPF_CUTOFF | 50 Hz | 確定 |
| NOISE_MEASURE_MS | 500 | 仮 |
| GATE_MARGIN_DB / GATE_FLOOR_DBFS | +12 / **-62** | margin=仮 / floor=**較正済**(2026-08-16) |
| ONSET_MIN_VOICED_MS | 150 | 仮 |
| VALID_MIN_VOICED_MS | 500ms | 仮(validity判定+phonating無音終了の有効化条件) |
| LISTEN_TIMEOUT_MS / TOO_NOISY_FLOOR_DBFS / REFERENCE_TONE_MS | 10000 / -30 / 1500 | 仮(Exerciseフロー) |
| MEDIAN_N | 5 | 仮 |
| EMA_ALPHA | 0.3(centドメイン) | 仮 |
| PITCH_OK_CENTS | 50 | 仮 |
| STABILITY_SIGMA_NORM | 100 cent | 仮 |
| ATTACK_NORM_S | 2.0 s | 仮 |
| INTERVAL_NORM_CENTS | 200 | 仮(Level 3) |
| OCTAVE_ANCHOR_MS | 300 | 仮 |
| OCTAVE_OFF_TOLERANCE_CENTS | 100 | 仮 |
| GUARD_AFTER_PLAYBACK_MS | 250 | 仮 |
| PHONATION_MAX_S / SILENCE_END_MS | 5 / 500 | 仮 |
| RANGE_PASS_SECONDS / RANGE_BIN_MIN_MS / RANGE_MIN_BINS | 6s / 150 / 3 | 仮(音域チェック。BIN_MIN 250→150 = 2026-08-16誤測定事故対応) |
| RANGE_CONF_DROP / RANGE_JITTER_FACTOR | 0.08 / 1.8 | 仮(「楽に出せる範囲」判定 — TRAINING_MODEL.md 音域チェック) |
| RANGE_BIN_GAP_BRIDGE / RANGE_MIN_COMFORT_BINS | 2 / 5 | 仮(橋渡し半音数 / 楽な範囲の最小幅。2026-08-16誤測定事故対応) |
| DISPLAY_RANGE_CENTS | ±200 | 仮(UX) |
| ZONE_OK_CENTS / ZONE_NEAR_CENTS | 50 / 100 | 仮(UX) |
| LATENCY_BUDGET_MS | 100 | 目標値 |

「仮」の較正はiPhone実機で実施し、較正後に本表・UX_TRAINING.md・コード定数(src/core/constants.ts)を同時更新する。

### 較正記録(2026-08-16 ユーザーiPhone・「んー」4録音、解析=src/calibration.analysis.test.ts)

- 環境ノイズフロア: -73〜-75dBFS(静かな室内)/ 通常声: -39dBFS前後 / 小声: -53〜-56dBFS
- **GATE_FLOOR_DBFS -55→-62 に較正**(小声の49.6%がtooQuiet化していたため。相対gate(+12dB)は適正動作)
- PITCH_OK_CENTS=50: 妥当確認 — 伸ばした声の91〜100%が自身の中央値±50cent内(medAbs 10〜14cent)
- YIN_THRESHOLD=0.15: 妥当確認 — voiced中のconfidence中央値0.98〜1.00、unclear率0.1〜1.3%
- 安定区間σ(実測): 9〜23cent → STABILITY_SIGMA_NORM=100は維持(識別力はユーザー数が増えたら再評価)
- ユーザーの快適発声域(観測): D#3〜C#4(153〜273Hz)→ 声域設定はどちらでも可、「低め」が中心に近い
