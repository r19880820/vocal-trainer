# Backlog(Phase別)

Phase定義の正本。上から順に実施。
**Playable MVP = Phase 3〜5 の縦切り(3つで1マイルストーン)。ここまで横に広げない。**
(Phase 3単体では評価も提案もなく「次に何を練習すればいいか分かる」を満たさない)

## Phase 0: Product / Architecture設計 ✅
- [x] Product Vision / Architecture / Audio Analysis / Training Model 文書化
- [x] ADR-001(YIN)レビュー・確定
- [x] UX_TRAINING.md(初心者向け文言・画面フロー)
- [x] Web-first転換(ADR-003)、`C:\dev\vocal-trainer` へ移設、環境=Node(導入済)

## Phase 0.5: iPhone Safari 音声リスク検証(ADR-003の最大リスクを先頭で潰す)
- [ ] getUserMedia(EC/NS/AGC=false要求)→ `getSettings()` 読み戻しで実際の適用を確認
- [ ] `AudioContext.sampleRate` 実値確認(通常48kHz)、AudioWorklet安定動作、タップ起点resume
- [ ] 無効化できない場合は仕様側で吸収を判断(ADR-003更新)
- ※ デバッグ画面(Phase 1)が実測値をオンスクリーン表示するので、それをiPhoneで開くだけで検証できる

## Phase 1: Pitch Detection PoC
- [ ] Vite+TS+React skeleton(core純TS構成・Web Worker・Vitest・HTTPS dev server)
- [ ] ハーフバンドFIR(÷2)リサンプラ + YIN実装
- [ ] 合成波形テスト: **F0スイープ80〜700Hzバイアス曲線で全帯域±10cent**(サイン/倍音付き/ノイズ混入)
- [ ] リアルタイムデバッグ表示: Hz / Note / cent / confidence / amplitude / 実レート / getSettings()
- [ ] **録音・再生ハーネス**: 生PCMを保存し、パイプラインへオフライン再投入できる回帰基盤
      (閾値較正の再現性・「もう一回歌ってみる」デバッグからの脱却・iPhone較正の土台)
- [ ] 起動時セルフテスト(440Hz再生→録音→440±20Hz)
- [ ] スループット実測(<10.7ms/hop)+ **ループバック遅延実測**(表示遅延≤100ms予算)

## Phase 2: リアルタイムPitch Indicator
- [ ] 処理層実装+テスト(DC/HPF・相対gate・voicing 4値・octave fix(単発のみ)・median・表示EMA)
- [ ] 低い←●→高い インジケータUI(60fps、UX_TRAINING.md準拠)
- [ ] お手本音の生成・再生(サイン波+明示的リリース)+ 再生後ガード区間

## Phase 3: Level 2「1音合わせ」フロー
- [ ] ExerciseEngine状態機械(TRAINING_MODEL.mdの遷移表どおり。マイク権限フロー含む)
- [ ] 環境ノイズ測定(500ms)と「静かな場所で」案内、イヤホン推奨表示
- [ ] 音程軌跡表示

## Phase 4: Scoring / Weakness Detection
- [ ] 指標算出(pitchAccuracy / medianAbsCents / pitchStability? / attackAccuracy? / octaveOff)+単体テスト
      (null=測定不能を0と区別。オクターブ違い・目標未到達・遅い入り・不安定の合成系列でテスト)
- [ ] validity(tooShort/tooQuiet)、WeaknessDetection(バンド順位+ヒステリシス+専用ブランチ)
- [ ] 結果画面(改善ポイント1つ、UX_TRAINING.md準拠)

## Phase 5: Training Recommendation → **ここでMVP完成**
- [ ] 弱点→練習マッピング(推奨結果=実行可能なExerciseSpec、パラメータ違い再起動)
- [ ] 練習バリエーション(音域狭め/ロングトーン/アタック/オクターブ寄せ)
- [ ] **MVP受入テスト**: test-retest(連続3回でprimaryWeakness一致)ほか TRAINING_MODEL.md の受入条件

## Phase 6: Level 1 / 3 / 4
- [ ] Level 1(方向のみ)、Level 3(interval/direction算出の実装)、Level 4(Pitch Curve比較)
- [ ] **発声モードのバリエーション検討(ユーザー発案 2026-08-16)**: リップロール等のSOVT系
      (半閉鎖声道: リップロール・ストロー発声・ハミング)を練習の「声の出し方」として案内する。
      現行の「んー」=ハミングも同系統。測定はF0のままで変更不要だが、
      リップロールは唇の振動(20-30Hz)で振幅変調が乗るため YIN の confidence/voicing が
      揺れないか要実測。特に適合: pitchStability(ロングトーン)/ 将来のVocal Range測定(サイレン)

## Phase 7: Progress Tracking
- [ ] Storage実装ADR(ADR-004: localStorage vs IndexedDB)→ SkillSnapshot永続化(paramsVersion付き)、週次推移表示

## Phase 8: Rhythm Training
- [ ] レイテンシ較正(sampleIndex基準)、timing/durationAccuracy

## Phase 9: Phrase Training
- [ ] フレーズ分解、DTW比較、苦手Phrase抽出、回り込み検出(お手本F0既知の利用)

## Phase 10: AI Coach
- [ ] 診断説明・練習メニュー生成(入力は構造化データのみ)
