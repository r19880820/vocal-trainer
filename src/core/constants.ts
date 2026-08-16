// 定数の正本は docs/AUDIO_ANALYSIS.md §8。変更時は必ず両方を同期させること。
// 「仮」の値の較正は iPhone 実機のみで行う(ADR-003)。

export const PARAMS_VERSION = 1;

// --- Capture / resample (§1) ---
export const INTERNAL_RATE_DIVISOR = 2; // 内部レート = AudioContext.sampleRate ÷ 2

// --- YIN (§2) ---
export const YIN_WINDOW = 1024; // W。不変条件 W >= 2 * tauMax
export const YIN_HOP = 256; // 内部レート基準(24kHzで10.7ms)
export const F0_MIN_HZ = 60; // 下限60Hz=「目標C3を1オクターブ下(65Hz)で歌う」誤りの検出用(レビューC-1)
export const F0_MAX_HZ = 700;
export const YIN_THRESHOLD = 0.15; // 仮

// --- Processing (§3) ---
export const HPF_CUTOFF_HZ = 50;
export const NOISE_MEASURE_MS = 500; // 仮
export const GATE_MARGIN_DB = 12; // 仮
export const GATE_FLOOR_DBFS = -62; // 較正済(2026-08-16 iPhone実録4本: 小声が-53〜-56dBFSに分布し-55では49.6%がtooQuiet化)
export const ONSET_MIN_VOICED_MS = 150; // 仮
export const MEDIAN_N = 5; // 仮
export const EMA_ALPHA = 0.3; // 仮。centドメインで適用(Hzドメイン禁止)
export const OCTAVE_ANCHOR_MS = 300; // 仮

// --- Scoring (§5) ---
export const VALID_MIN_VOICED_MS = 500; // 仮(validity + phonating無音終了の有効化条件)
export const PITCH_OK_CENTS = 50; // 仮
export const STABILITY_MIN_MS = 300; // 仮(到達後の有声時間がこれ未満なら pitchStability=null — レビューC-2)
export const REACH_TARGET_ACCURACY = 0.05; // 仮(これ未満は「まず到達」専用ブランチ — レビューC-3)
export const STABILITY_SIGMA_NORM_CENTS = 100; // 仮
export const ATTACK_NORM_S = 2.0; // 仮
export const INTERVAL_NORM_CENTS = 200; // 仮(Level 3)
export const OCTAVE_OFF_TOLERANCE_CENTS = 100; // 仮

// --- Exercise flow ---
export const GUARD_AFTER_PLAYBACK_MS = 250; // 仮
export const PHONATION_MAX_S = 5; // 仮
export const SILENCE_END_MS = 500; // 仮
export const LISTEN_TIMEOUT_MS = 10000; // 仮(TRAINING_MODEL.md 状態遷移表)
export const TOO_NOISY_FLOOR_DBFS = -30; // 仮(環境ノイズがこれ以上なら「静かな場所で」案内)
export const REFERENCE_TONE_MS = 1500; // 仮(お手本音の長さ)

// --- Training recommendation クランプ(レビューM-4/M-5) ---
export const TARGET_MIDI_MIN = 48; // 仮(C3)
export const TARGET_MIDI_MAX = 69; // 仮(A4)
export const TOWARD_USER_MIDI_MIN = 40; // 仮(E2≈82Hz。「ユーザーの声域側へ寄せる」提案専用の下限 — レビューN-2。F0_MIN=60Hzで検出可能)
export const DURATION_MIN_MS = 800; // 仮
export const DURATION_MAX_MS = 4000; // 仮

// --- 音域チェック(Range Check v2「音についていく方式」。TRAINING_MODEL.md「音域チェック」/ AUDIO_ANALYSIS.md §8) ---
export const RANGE_STEP_TONE_MS = 700; // 仮(各ステップのお手本再生長)
export const RANGE_STEP_CAPTURE_MS = 2000; // 仮(お手本再生後の捕捉時間。1500→2000: 反応時間の余裕 — 2026-08-16 v2初回実測で全滅事故)
export const RANGE_STEP_MATCH_CENTS = 150; // 仮(matched判定: |目標比cents中央値|がこれ以下)
export const RANGE_STEP_COMFORT_CENTS = 75; // 仮(comfortable判定: matchedのうち|cents中央値|がこれ以下)
export const RANGE_STEP_MIN_VOICED_MS = 400; // 仮(matched判定に必要な最小有声時間)
export const RANGE_STEP_COMFORT_SIGMA_CENTS = 50; // 仮(comfortable判定: centsの標準偏差がこれ以下=「ぶれずに出せた」。2026-08-16 ユーザー指摘「きれいかどうか見てない」対応)
export const RANGE_MAX_STEPS = 8; // 仮(各パスの最大ステップ数)
export const RANGE_MIN_COMFORT_BINS = 5; // 仮(保存済み「楽な範囲」の幅がこれ未満なら測定失敗として正直に返す — v1誤測定事故対策。TrainingAppの保存値ガードが使用中)

// --- Level 1「音の上下」(TRAINING_MODEL.md「Level 1: 音の上下」/ AUDIO_ANALYSIS.md §8) ---
export const L1_TRIALS = 5; // 仮(1セットの問題数)
export const L1_TONE_MS = 600; // 仮(A/B各音の再生長)
export const L1_TONE_GAP_MS = 250; // 仮(A→B間の無音)
export const L1_CAPTURE_MS = 5000; // 仮(捕捉時間。4000→5000: 反応と2音分の余裕 — 2026-08-16 実地で全問測定不能事故)
export const L1_SEGMENT_MIN_VOICED_MS = 300; // 仮(有効セグメントの最小有声時間)
export const L1_SEGMENT_GAP_MS = 150; // 仮(セグメント分割の無音ギャップ。250→150: 素早い歌い直しでも区切れるように — 同事故対応)
export const L1_FALLBACK_MIN_VOICED_MS = 600; // 仮(前半/後半フォールバック判定に必要な有声合計 — 同事故対応)
export const DIRECTION_SAME_CENTS = 50; // 仮(「同じ」判定幅)
export const L1_MIN_INTERVAL_SEMITONES = 3; // 仮(出題の最小音程)
export const L1_MAX_INTERVAL_SEMITONES = 7; // 仮(出題の最大音程)
export const L1_SAME_PROB = 0.2; // 仮(B=Aとなる確率)

// --- UX display (UX_TRAINING.md §4) ---
export const DISPLAY_RANGE_CENTS = 200; // 仮
export const ZONE_OK_CENTS = 50; // 仮
export const ZONE_NEAR_CENTS = 100; // 仮

// --- Budgets ---
export const LATENCY_BUDGET_MS = 100; // 目標値
