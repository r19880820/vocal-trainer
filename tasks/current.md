# Current Tasks

更新日: 2026-08-16(Web-first転換後)

## 進行中スプリント: Phase 0.5 / 1(iPhone Safari PoC・Pitch Detection)

| ID | タスク | 担当 | 状態 |
|---|---|---|---|
| T8 | Web-first転換: ADR-003起票+全docs改訂(ADR-002 Superseded) | Fable | ✅ 完了 |
| T9 | リポジトリ移設 → `C:\dev\vocal-trainer`(Q1承認済) | Fable | ✅ 完了 |
| T10 | Vite+TypeScript+React scaffold+Vitest+core型/定数 | Fable | ✅ 完了 |
| T11 | core DSP実装: 変換式/ハーフバンド÷2/YIN+F0スイープテスト | Sonnet(実装)→Fable(検証) | ✅ 完了(134テストPASS・スイープ最大誤差1.80cent/目標±10cent・仕様判断5点はAUDIO_ANALYSIS.md §2に反映) |
| T12 | platform(AudioWorklet捕捉+pitch-worker)+デバッグ画面(=Phase 0.5 PoCページ兼用) | Fable | ✅ 完了(build・HTTPS dev server 200確認) |
| T13 | **iPhone実機PoC** | ユーザー+Fable | ✅ **完全クローズ**(動作確認OK+読み戻し確定: 48000Hz / EC=false適用 / NS・AGC非報告→ADR-003に記録) |
| T15 | core/processing 実装(HPF・相対gate・voicing4値・octave fix・median・EMA)+テスト | Sonnet-A | ✅ 完了(37テスト。octave fix=単発補正/3連続でアンカー切替) |
| T16 | core/features+scoring+diagnosis+training 実装+全分岐テスト | Sonnet-B | ✅ 完了(47テスト。octave補正後採点・時間重み付き・validity=tooQuiet優先) |
| T17 | ExerciseEngine(状態機械)+Level 2 本番UI(SC-1〜SC-5、UX_TRAINING準拠) | Fable | ✅ 完了(統合検証: typecheck✓ / 218テスト✓ / build✓) |
| T18 | 採点・診断ロジックのOpus設計レビュー(実装後) | Opus | ✅ 完了(**Critical 5 / Major 10 / Minor 12。総合判定=修正まで使用不可**) |
| T19 | レビュー修正: 仕様裁定+docs改訂(C-5文言統一・C-3条件・M-1 validity再設計・F0_MIN=60・クランプ・allGood) | Fable | ✅ 完了 |
| T20 | レビュー修正: engine(C-4/M-6/M-8/m-5/m-12)+UI(M-7/M-9/m-7)+copy(C-5/m-4/allGood) | Fable | ✅ 完了 |
| T21 | レビュー修正: yin(C-1)+score(C-2/M-1)+diagnose(C-3/M-2/M-3)+recommend(M-4/M-5)+engineテスト(M-10) | Sonnet | ✅ 完了 |
| T22 | 修正後の統合検証+Opus再確認 | Fable+Opus | ✅ 完了(**C-1〜C-5/M-1〜M-9全合格。C-1は数値で再検証済み。総合判定=実機較正フェーズ開始可**) |
| T23 | Opus再確認の新規指摘: N-1(短発声の無限往復→2回目で採点)+N-2(声域側提案の下限=TOWARD_USER_MIDI_MIN 40) | Fable | ✅ 完了(回帰テスト追加。**250テスト全PASS**・typecheck✓・build✓) |
| T24 | Phase 1宿題=較正の土台: 録音再生ハーネス(offline pipeline)+440Hzセルフテスト自動化+ループバック遅延実測(DebugPage較正ツール) | Sonnet(実装)/Fable(検証+セルフテスト無音リードイン600ms修正) | ✅ 完了(**260テスト全PASS**・typecheck✓・build✓。実機UI動作はiPhone確認待ち) |
| T25 | **iPhone較正セッション** | ユーザー+Fable | ✅ 完了 — ①セルフテストPASS(439.5Hz) ②遅延84ms ③4録音解析→**GATE_FLOOR_DBFS -55→-62に較正**(小声のvoiced率15.6%→44.9%改善)。±50cent/YIN閾値0.15/σ正規化100は妥当確認。解析ハーネス=src/calibration.analysis.test.ts(recordings/がある環境のみ実行)。261テスト全PASS |
| T26 | **test-retest受入(MVPゲート最後の1つ)** | ユーザー+Fable | ✅ **合格** — 3回連続で同一診断(ユーザー報告「全部つぎの高さ」= 文言の正確な内訳は未確認、「音の高さ」か「つぎの音(allGood)」のいずれか。一致自体は確定)。**→ Playable MVP 完成(2026-08-16)** |

| T27 | 公開(Q4): 初回commit+GitHub公開リポジトリ+Pages自動デプロイ(テスト全緑ゲート付き) | Fable | ✅ 完了(2026-08-16)— **https://r19880820.github.io/vocal-trainer/** 稼働中 |
| T28 | **Phase 7 成長記録**: ADR-004(localStorage)+progressStore+週次集計+「せいちょう」画面+ホーム配線 | Sonnet(実装)/Fable(レビュー・デプロイ) | ✅ 完了・本番反映済(290テスト全PASS、commit d127ab4) |

| T29 | 目標音のスケール音化+音名表示+ズレ傾向+方向付きアドバイス(ユーザーフィードバック2件) | Fable | ✅ 完了・本番反映済(commit b8440e9, 1e7b345。295テスト) |
| T30 | **音域チェック(Vocal Range前倒し — ユーザー発案)**: グリッサンド測定→楽に出せる範囲/がんばれば範囲→お手本プール自動適応 | Sonnet(実装)/Fable(設計・検証) | ✅ 完了(副産物: visibilitychange時のrangeSessionマイク解放バグを実装中に検出・修正済) |
| T31 | **音域チェック誤測定事故の修正**: 実ユーザーで「楽な範囲=シ2〜ド#3(幅3半音)」— 滞在250ms資格+厳密連続+中央基準の複合欠陥で、スライド末尾の滞在点を誤認 → 資格150ms/橋渡し2半音/基準=良い声側四分位/幅5半音未満はfail-loud+保存済み異常値ガード | Fable | ✅ 完了・本番反映済(commit a5602f0、313テスト。**ユーザーに再測定を依頼中**) |

| T32 | **音域チェックv2「音についていく方式」**(ユーザー提案: 自由スライドは初心者に困難)— お手本がスケールを1音ずつ移動、matched/comfortable判定、滞在時間をアプリ制御 | Fable(設計)/Sonnet(実装)/Fable(検証) | ✅ 完了・本番反映済(commit c1ab118、316テスト。**ユーザーの再測定待ち**) |

## 次の候補(Phase 6 以降 — 着手前にユーザー確認不要、推奨順)

1. **Phase 6**: Level 1(音の上下)→ Level 3(2音)→ Level 4(メロディ)。interval/direction 算出の実装解禁
2. PWA化(ホーム画面アイコン・オフラインキャッシュ)/ 履歴エクスポート(バックログ)
3. 技術負債: rationale文字列契約の型化 / attackAccuracy飽和(実運用データが貯まったら再評価)

## 技術負債・実機較正の観測項目(Opus再確認 N-3〜N-5 + 見送り分)

- N-3/m-2: diagnose→recommend の allGood・ヒステリシスが rationale **文字列**契約(型で守られていない)→ Diagnosis 型拡張が本筋
- N-4: attackAccuracy が2秒超到達で0に飽和し「音の入り」診断のアトラクタになる → **実機較正で REACH_TARGET_ACCURACY と ATTACK_NORM_S をセットで観測**(飽和時null化も検討)
- N-2関連: 低い男声で目標が十分下がるか(TOWARD_USER_MIDI_MIN=40 の妥当性)を実機で観測
- m-9: octaveOff 50%境界のヒステリシスなし(実機較正後に判断)/ m-11: result画面でマイク継続(意図的)

## 次のマイルストーン

1. **iPhone実機でMVP一周**(ユーザー): `https://192.168.0.158:5173` — お手本→発声→リアルタイム→結果→次の練習。あわせて `?debug` で EC/NS/AGC・sampleRate の読み戻し値を確認(T13の残項目)
2. 実機較正(仮値の閾値をiPhone実測で調整)+ test-retest 受入テスト
3. Q4: 公開ホスティング先の決定(旅先・外出先からも使えるURL)

### T18レビューの主要指摘(詳細はOpus出力、対応はT19-T21)
- C-1: F0_MIN=80だと低め声域の1オクターブ下(65-78Hz)が80Hzに張り付き「聞こえません」無限ループ+octaveOff検出不能 → F0_MIN=60+τ張り付きfail-loud
- C-2: 1サンプル到達でσ=0→「とても安定」誤褒め → STABILITY_MIN_MS=300
- C-3: 一瞬±50centをかすると「まず到達」ブランチが外れ「素早く合わせろ」+0.6倍速練習 → pitchAccuracy<0.05単独条件
- C-4: 「あ、はい」の相槌500ms無音で採点確定 → 有声500ms未満はlistening復帰
- C-5: オクターブ文言「高い声で」とボタン動作「お手本を下げる」が正反対 → 裁定=ユーザーの声域側へ寄せる方向に統一
- M-1: validity分母が録音全体=発声前の待ち時間で判定反転(test-retest破壊) → voicedMs優先の再設計
- 未対応と決めたもの: m-2(rationale文字列ヒステリシス=技術負債として記録)/ m-9(octaveOff境界ヒステリシス=実機較正後に判断)/ m-11(result画面でマイク継続=意図的)/ m-6(onset定義1ホップ差=許容)

## 解決済みブロッカー

- ~~Q1 置き場~~ → `C:\dev\vocal-trainer` へ移設済(ユーザー承認 2026-08-16)
- ~~Q2 環境構築~~ → Web-first化によりNodeのみで完結(導入済)。AIが実施
- ~~Q3 Android実機~~ → 不要(ユーザー端末=iPhone、Webアプリ化。ADR-002 Superseded)

## 未確定事項

- **Q4: 公開ホスティング先** — iPhoneから常用するURL(GitHub Pages / Vercel 等)。
  開発中は同一Wi-Fi+HTTPSで足りるため、MVP形になった時点でユーザーに確認
