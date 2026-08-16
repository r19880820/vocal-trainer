# ADR-003: Web-first(iOS Safari向けWebアプリ)への転換

- Status: **Accepted**(2026-08-16 ユーザー指示による方針転換)
- Date: 2026-08-16
- Decider: ユーザー(方向決定)/ Fable(技術詳細)
- Supersedes: [ADR-002](ADR-002-mobile-framework.md)(Flutterネイティブ)

## Context

ADR-002 は「iOS/Androidネイティブ、Android実機先行」を前提にしていたが、以下が判明した:

- **ユーザーの端末は iPhone**(Android実機なし → ADR-002 の検証計画が成立しない)
- ユーザーの要望は「**iOSでWebアプリが動く状況**」(App Storeネイティブ配布は要求されていない)
- 開発機は Windows(macOSなし)— ネイティブiOSはローカルビルド不可だが、**WebアプリならiPhoneのSafariで即動く**

Web Audio API の能力: getUserMedia + AudioWorklet(iOS Safari 14.5+)でリアルタイムF0検出は実現可能。
MVP(1音合わせ)はバックグラウンド動作・低遅延演奏用途ではないため、Webの制約内に収まる。

## Decision

**モバイルWebアプリ(将来PWA化)として開発する。ターゲットは iOS Safari(+デスクトップブラウザ)。**

技術スタック:

| 層 | 選定 |
|---|---|
| 言語 | TypeScript(strict) |
| ビルド/開発 | Vite |
| UI | React |
| テスト | Vitest |
| 音声入力 | getUserMedia + AudioWorklet(捕捉)→ Web Worker(YIN+処理層) |
| お手本再生 | Web Audio(OscillatorNode/生成バッファ+明示的リリース) |
| DSP | 純TypeScript(core、DOM/Web API import禁止)。性能不足時のみWASM化 |
| ストレージ(将来) | localStorage / IndexedDB(Phase 7 で ADR) |

検証順序:

1. **デスクトップブラウザ(Windows Chrome/Edge)** — core ロジック・UIの反復開発
2. **Phase 0.5 = iPhone Safari 実機PoC** — 本ADRの最大リスクを先頭で検証:
   - getUserMedia constraints(echoCancellation / noiseSuppression / autoGainControl = **false**)が
     実際に適用されるか(`MediaStreamTrack.getSettings()` で読み戻し確認)
   - `AudioContext.sampleRate` の実値(iOSは通常48kHz)
   - AudioWorklet の安定動作、ユーザー操作起点の AudioContext resume
   - (後続)ホーム画面追加PWAモードでのマイク動作
3. **音響パラメータの較正は iPhone 実機のみ**。デスクトップブラウザ実測から採用しない(ADR-002の「Windows較正禁止」を継承)

開発中のiPhone実機アクセス: `vite --host` + 自己署名HTTPS(@vitejs/plugin-basic-ssl)で同一Wi-Fiから
`https://<PCのIP>:5173`(getUserMediaはsecure context必須)。証明書警告が問題になる場合は
cloudflared quick tunnel 等の実HTTPSトンネルを使用。安定版の配布は静的ホスティング
(GitHub Pages / Vercel 等 — 未確定事項Q4)。

## Consequences

- (+) **Mac・App Store・CI不要**。ユーザーのiPhoneにURLだけで届く。環境構築はNodeのみ(導入済)
- (+) core純TS + 層分離(ARCHITECTURE.md)はそのまま維持。ADR-001(YIN、内部レート=実レート÷2)も変更なし(48kHz→24kHz)
- (+) 将来App Store配布が必要になれば Capacitor 等でWebアプリをそのまま包める(coreは全再利用)
- (−) iOS SafariのWeb Audioにはネイティブほどの音声セッション制御がない。constraints の実挙動は端末/OSバージョン依存 → Phase 0.5 で事実確認し、無効化できない場合は診断表示+仕様側で吸収(このADRを更新)
- (−) バックグラウンド・画面ロック中の動作は不可(MVPでは不要)
- (−) WindowsからiOS SafariのWebインスペクタが使えない → デバッグ画面(Phase 1)に実測値・エラーの
  オンスクリーン表示を組み込む
- (−) ブラウザの自動再生制限により、音声開始は必ずユーザー操作(タップ)起点にする

## Phase 0.5 検証結果(2026-08-16 ユーザーiPhone実機・確定)

| 項目 | 実測値 | 判定 |
|---|---|---|
| AudioContext.sampleRate | 48000 Hz(→内部レート24000) | ✅ 設計どおり |
| echoCancellation | **false** | ✅ 最重要項目: AEC無効化要求が実際に適用されている |
| noiseSuppression / autoGainControl | getSettings() にキー自体が無い | ⚠ このiOS/Safariでは制御・報告不可 |

NS/AGC は「制御できない可能性」を前提に設計済み(相対silence gate・振幅にほぼ依存しないYIN)のため
**本ADRの前提は成立、Web-first 継続**。NS/AGC の実害有無は較正フェーズの実測(録音ハーネス)で確認する。

## ADR-002 からの引き継ぎ

- 「最大リスク(実機の音声入力品質)を先頭で検証する」原則 — 対象がAndroid実機→iPhone Safariに変わっただけ
- 「開発PC実測を較正に使わない」原則
- Flutter比較検討の記録は ADR-002 に保存(参照用)
