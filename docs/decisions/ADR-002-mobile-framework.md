# ADR-002: モバイルフレームワーク

- Status: **Superseded by [ADR-003](ADR-003-web-first-ios.md)**(2026-08-16。ユーザー端末=iPhone・Web アプリ希望が判明し、ネイティブ前提が消滅。Flutter比較検討は参照用に保存)
- Date: 2026-08-16
- Decider: Fable(起案・統合)/ Opus(レビュー)

## Context

iOS / Android 対応。**リアルタイム音声解析の品質を最優先**(開発速度だけで選ばない)。
制約: 開発機は Windows 11(macOSなし → iOSビルドはローカル不可)。
リアルタイムPitchインジケータの滑らかな描画(60fps)が中核UX。

## 検討した選択肢

| 選択肢 | 音声リアルタイム性 | 開発効率 | 備考 |
|---|---|---|---|
| **Flutter** | ○(マイクはplugin/platform channel、DSPはDart AOT+ワーカーisolate。不足時はFFIでC) | ○ | 60fps描画が得意。Windowsデスクトップターゲットで core ロジックとUIを開発PC上で反復できる |
| React Native / Expo | △(音声ストリームはネイティブモジュール必須、JSブリッジ/JSIの複雑さ) | ○ | リアルタイム音声系のエコシステムが弱く、結局ネイティブ実装が二重化する |
| Native (Swift/Kotlin) | ◎ | ✕(二重実装) | macOSなし環境でiOS側を開発できず、MVP速度も出ない |
| Web (PWA) | △(モバイルブラウザのマイク制約) | ◎ | 将来のデモ用途のみ |

## Decision

**Flutter を採用。** ただし検証順序は「Windows先行」ではなく**「Android実機の音声リスクを最初に潰す」**:

1. **Phase 0.5(最優先)**: Android 実機で、マイクプラグイン(第一候補 `record`、不可なら platform channel 自前)による
   **生PCMストリーム取得 + OS音声前処理(AEC/NS/AGC)の無効化 + actualSampleRate 読み戻し**を単独検証する。
   これが本ADRの最大リスクであり、Windowsでは検証不能(WindowsにはVOICE_RECOGNITION/measurement modeに相当する
   無効化手段がなく、ベンダーAPOがドライバ層で掛かる)
2. **Windows desktop ターゲットは core ロジック・UI の反復専用**。
   **音響パラメータ(RMS gate、YIN閾値、cent許容幅等)の較正値を Windows 実測から採用することを禁止**する
   (AGC無効のAndroid実機とはゲイン系が別物。較正はAndroid実機で行う)
3. DSP(YIN・処理層・採点)は**純 Dart + ワーカーisolate**で実装。性能不足が実測されたら FFI + C に移す
4. お手本音再生: 生成PCM(サイン波+明示的リリース付きエンベロープ)をローカル再生
5. iOS は クラウドCI(Codemagic / GitHub Actions macOS runner)確保後

## Consequences

- (+) core ロジックがモバイル/デスクトップ共通。ロジック・UIの反復は開発PC単体で可能
- (+) 1コードベースで iOS/Android
- (−) Flutter SDK + Android Studio(Android SDK/エミュレータ)+ Windowsターゲット用に
  Visual Studio「C++によるデスクトップ開発」ワークロード(数GB)のセットアップが必要(現在未インストール)
- (−) iOS 検証は後回し(CI導入まで)
- (−) マイクプラグインが要件(生PCM/前処理無効化/実レート読み戻し)を満たさない場合、
  platform channel 自前実装に切り替える(Phase 0.5 で判明させる)

## 環境上の注意(要ユーザー確認 — tasks/decisions.md Q1)

現フォルダは **OneDrive 配下 + 日本語パス**。以下の理由で **`C:\dev\vocal-trainer` 等の
ASCIIローカルパスへ docs ごと移設**を推奨:

- Gradle/Android ビルドは非ASCIIパスで失敗する事例が多い
- OneDrive 同期はビルド生成物・ファイル監視(hot reload)と衝突する
- **`.git` を OneDrive が同期するとリポジトリ破損のリスク**がある
- Flutter SDK 本体・pub cache・Gradle cache も OneDrive 外に置くこと
