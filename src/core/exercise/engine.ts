// ExerciseEngine: Level 2「1音合わせ」の状態機械(TRAINING_MODEL.md の遷移表が正本)。
// core の調整役 — platform には依存せず、ExerciseAudioPort 経由で音声入出力を受ける。
// 2026-08-16 Opusレビュー C-4(相槌採点防止)/ M-6(ガード起点)/ M-8(番犬)/ m-5 / m-12 反映。
import type {
  Diagnosis,
  ExerciseResult,
  ExerciseSpec,
  ProcessedPitchSample,
  RawPitchSample,
} from '../types';
import {
  GUARD_AFTER_PLAYBACK_MS,
  LISTEN_TIMEOUT_MS,
  NOISE_MEASURE_MS,
  ONSET_MIN_VOICED_MS,
  PHONATION_MAX_S,
  REFERENCE_TONE_MS,
  SILENCE_END_MS,
  TOO_NOISY_FLOOR_DBFS,
  VALID_MIN_VOICED_MS,
} from '../constants';
import { centsBetween, midiToHz } from '../pitch/conversions';
import { PitchProcessor } from '../processing/processor';
import { scoreExercise } from '../scoring/score';
import { diagnose } from '../diagnosis/diagnose';
import { recommend, type RecommendationKey } from '../training/recommend';

export type EngineState =
  | 'idle'
  | 'micCheck' // SC-2: マイク確認(レベルメータ表示のみ)
  | 'micDenied'
  | 'calibrating'
  | 'tooNoisy'
  | 'playingReference'
  | 'listening'
  | 'phonating'
  | 'scoring'
  | 'result'
  | 'listenTimeout';

export interface ExerciseOutcome {
  result: ExerciseResult;
  diagnosis: Diagnosis;
  next: { spec: ExerciseSpec; reasonKey: RecommendationKey };
}

export interface LiveDisplay {
  /** 表示用EMA系列 vs 目標のcent差。voiced でなければ null */
  cents: number | null;
  voicing: ProcessedPitchSample['voicing'];
}

export interface EngineCallbacks {
  onState(state: EngineState): void;
  onLive(display: LiveDisplay): void;
  /** SC-2 レベルメータ用(dBFS) */
  onLevel(rmsDb: number): void;
  onResult(outcome: ExerciseOutcome): void;
  onError(message: string): void;
}

/** platform/AudioSession が構造的に満たす境界(core は platform を import しない) */
export interface ExerciseAudioPort {
  start(
    onRaw: (s: RawPitchSample) => void,
    onError: (m: string) => void,
  ): Promise<{ internalSampleRate: number }>;
  stop(): void;
  /** 再生が「鳴り終わった」時点で resolve すること(ガード区間の起点 — レビューM-6) */
  playTone(hz: number, durationMs: number): Promise<void>;
  readonly running: boolean;
}

const WATCHDOG_CHECK_MS = 2000;
const WATCHDOG_STALL_MS = 4000;
const LISTEN_TIMEOUT_EXTENSION_MS = 2000;

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rmsToDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

export class ExerciseEngine {
  private state: EngineState = 'idle';
  private processor: PitchProcessor | null = null;
  private internalRate = 0;
  private noiseFloorDb: number | null = null;
  private spec: ExerciseSpec | null = null;
  private samples: ProcessedPitchSample[] = [];
  private history: Diagnosis[] = [];
  private calibDbs: number[] = [];
  private calibStartMs: number | null = null;
  private voicedRunStartMs: number | null = null;
  private onsetMs: number | null = null;
  private lastVoicedMs: number | null = null;
  private prevSampleMs: number | null = null;
  private voicedAccumMs = 0;
  private shortRetryCount = 0; // レビューN-1: 短発声→listening復帰の回数(無限往復防止)
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRawWallMs = 0;

  constructor(
    private readonly port: ExerciseAudioPort,
    private readonly cb: EngineCallbacks,
    /** テスト注入用の壁時計(既定は Date.now) */
    private readonly now: () => number = () => Date.now(),
  ) {}

  getState(): EngineState {
    return this.state;
  }

  /** SC-2: マイクを起動しレベルメータのみ動かす(必ずタップハンドラから) */
  async startSession(): Promise<void> {
    try {
      const info = await this.port.start(
        (raw) => this.handleRaw(raw),
        (m) => this.cb.onError(m),
      );
      this.internalRate = info.internalSampleRate;
      this.setState('micCheck');
    } catch (e) {
      this.setState('micDenied');
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Exercise開始。セッション未開始なら開始してから進む */
  async beginExercise(spec: ExerciseSpec): Promise<void> {
    this.clearTimer();
    this.spec = spec;
    this.resetMeasurement();
    if (!this.port.running) {
      try {
        const info = await this.port.start(
          (raw) => this.handleRaw(raw),
          (m) => this.cb.onError(m),
        );
        this.internalRate = info.internalSampleRate;
      } catch (e) {
        this.setState('micDenied');
        this.cb.onError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (this.processor === null) {
      this.processor = new PitchProcessor(this.internalRate);
    }
    this.startWatchdog();
    if (this.noiseFloorDb === null) {
      // 較正はマイクセッションにつき1回(TRAINING_MODEL.md 遷移表: checkPermission→calibrating)
      this.calibDbs = [];
      this.calibStartMs = null;
      this.setState('calibrating');
    } else {
      this.playReference();
    }
  }

  /** 同一specでもう一回(result→playingReference) */
  retry(): void {
    if (this.spec) void this.beginExercise(this.spec);
  }

  /** キャンセル/バックグラウンド遷移: 録音破棄して idle(途中結果を採点しない) */
  cancel(): void {
    this.clearTimer();
    this.stopWatchdog();
    this.port.stop();
    this.processor = null;
    this.noiseFloorDb = null;
    this.setState('idle');
  }

  replayReference(): void {
    if (this.spec && (this.state === 'listening' || this.state === 'phonating')) {
      // 発声中の聞き直しは計測をやり直す(回り込み防止のためガードから再スタート)
      this.resetMeasurement();
      this.playReference();
    }
  }

  private resetMeasurement(): void {
    this.samples = [];
    this.onsetMs = null;
    this.voicedRunStartMs = null;
    this.lastVoicedMs = null;
    this.prevSampleMs = null;
    this.voicedAccumMs = 0;
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.cb.onState(s);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.lastRawWallMs = this.now();
    this.watchdog = setInterval(() => {
      const active =
        this.state === 'calibrating' ||
        this.state === 'playingReference' ||
        this.state === 'listening' ||
        this.state === 'phonating';
      if (active && this.now() - this.lastRawWallMs > WATCHDOG_STALL_MS) {
        this.cb.onError('マイクからの音声が途切れました。もう一度お試しください');
        this.cancel();
      }
    }, WATCHDOG_CHECK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private playReference(): void {
    if (!this.spec) return;
    this.clearTimer();
    this.shortRetryCount = 0;
    this.setState('playingReference');
    const target = this.spec.targets[0];
    const durationMs = target.durationMs > 0 ? target.durationMs : REFERENCE_TONE_MS;
    const guardMs = this.spec.guardAfterPlaybackMs > 0 ? this.spec.guardAfterPlaybackMs : GUARD_AFTER_PLAYBACK_MS;
    // playTone は「鳴り終わり」で resolve する契約 — ガードは実再生終了を起点にする(レビューM-6)
    this.port
      .playTone(midiToHz(target.midiNote), durationMs)
      .catch((e) => this.cb.onError(String(e)))
      .then(() => {
        if (this.state !== 'playingReference') return;
        this.timer = setTimeout(() => this.enterListening(), guardMs);
      });
  }

  private enterListening(): void {
    this.clearTimer();
    this.processor?.reset();
    if (this.noiseFloorDb !== null) this.processor?.setNoiseFloorDb(this.noiseFloorDb);
    this.resetMeasurement();
    this.setState('listening');
    this.armListenTimeout(LISTEN_TIMEOUT_MS);
  }

  private armListenTimeout(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.state !== 'listening') return;
      // 発声途中(voiced連続中)ならタイムアウトを延長する(レビューm-12)
      if (this.voicedRunStartMs !== null) {
        this.armListenTimeout(LISTEN_TIMEOUT_EXTENSION_MS);
      } else {
        this.setState('listenTimeout');
      }
    }, ms);
  }

  private handleRaw(raw: RawPitchSample): void {
    this.lastRawWallMs = this.now();
    const db = rmsToDb(raw.amplitude);
    this.cb.onLevel(db);

    switch (this.state) {
      case 'calibrating': {
        if (this.calibStartMs === null) this.calibStartMs = raw.timestampMs;
        if (Number.isFinite(db)) this.calibDbs.push(db);
        if (raw.timestampMs - this.calibStartMs >= NOISE_MEASURE_MS) {
          // 完全無音(有限dBが1つも無い)は「とても静か」であり tooNoisy ではない(レビューm-5)
          const floor = this.calibDbs.length > 0 ? median(this.calibDbs) : -80;
          if (floor > TOO_NOISY_FLOOR_DBFS) {
            this.setState('tooNoisy');
          } else {
            this.noiseFloorDb = floor;
            this.processor?.setNoiseFloorDb(floor);
            this.playReference();
          }
        }
        break;
      }
      case 'listening':
      case 'phonating': {
        if (!this.processor || !this.spec) return;
        const p = this.processor.process(raw);
        this.samples.push(p);
        const targetHz = midiToHz(this.spec.targets[0].midiNote);
        this.cb.onLive({
          cents: p.voicing === 'voiced' ? centsBetween(p.frequencyHzForDisplay, targetHz) : null,
          voicing: p.voicing,
        });

        const dtMs = this.prevSampleMs !== null ? p.timestampMs - this.prevSampleMs : 0;
        this.prevSampleMs = p.timestampMs;

        if (this.state === 'listening') {
          if (p.voicing === 'voiced') {
            if (this.voicedRunStartMs === null) this.voicedRunStartMs = p.timestampMs;
            if (p.timestampMs - this.voicedRunStartMs >= ONSET_MIN_VOICED_MS) {
              this.onsetMs = this.voicedRunStartMs;
              this.lastVoicedMs = p.timestampMs;
              this.voicedAccumMs = p.timestampMs - this.voicedRunStartMs;
              this.clearTimer();
              this.setState('phonating');
            }
          } else {
            this.voicedRunStartMs = null;
          }
        } else {
          // phonating: 終了条件 = 発声上限(spec.phonationMaxMs)or 連続無音500ms
          if (p.voicing === 'voiced') {
            this.lastVoicedMs = p.timestampMs;
            this.voicedAccumMs += dtMs;
          }
          const phonationMaxMs = this.spec.phonationMaxMs > 0 ? this.spec.phonationMaxMs : PHONATION_MAX_S * 1000;
          const sinceOnset = this.onsetMs !== null ? p.timestampMs - this.onsetMs : 0;
          const sinceVoiced = this.lastVoicedMs !== null ? p.timestampMs - this.lastVoicedMs : 0;
          if (sinceOnset >= phonationMaxMs) {
            this.finishAndScore();
          } else if (sinceVoiced >= SILENCE_END_MS) {
            // 「あ、はい」等の相槌で採点が確定しないよう、有声合計が
            // VALID_MIN_VOICED_MS 未満なら listening へ戻す(レビューC-4)。
            // ただし1回だけ — 短い発声を繰り返すユーザーには2回目で採点し
            // tooShort の正しい案内(「声を伸ばす長さ」)を出す(レビューN-1: 無限往復防止)
            if (this.voicedAccumMs >= VALID_MIN_VOICED_MS || this.shortRetryCount >= 1) {
              this.finishAndScore();
            } else {
              this.shortRetryCount += 1;
              const keepFloor = this.noiseFloorDb;
              this.processor.reset();
              if (keepFloor !== null) this.processor.setNoiseFloorDb(keepFloor);
              this.resetMeasurement();
              this.setState('listening');
              this.armListenTimeout(LISTEN_TIMEOUT_MS);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private finishAndScore(): void {
    if (!this.spec) return;
    this.clearTimer();
    this.setState('scoring');
    try {
      const result = scoreExercise(this.samples, this.spec, this.now());
      const diagnosis = diagnose(result, this.history);
      this.history = [...this.history.slice(-9), diagnosis];
      const next = recommend(diagnosis, result);
      this.setState('result');
      this.cb.onResult({ result, diagnosis, next });
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
      this.setState('idle');
    }
  }
}
