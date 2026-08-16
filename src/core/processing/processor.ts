// PitchProcessor: Raw→Processed 変換。正本は docs/AUDIO_ANALYSIS.md §3(順序どおりに適用)。
// このクラスが担うのは step2(voicing判定)〜step5(表示用EMA)。
// step0(DC除去+HPF)は core/audio/highpass.ts、step1(環境ノイズ500ms測定)は呼び出し側
// (platform/exercise層)の責務であり、その結果を setNoiseFloorDb() で受け取る。
//
// 処理層は目標非依存(ARCHITECTURE.md 原則5)。目標とのcents差はここでは計算しない。

import type { ProcessedPitchSample, RawPitchSample, Voicing } from '../types';
import { hzToMidi } from '../pitch/conversions';
import { EMA_ALPHA, GATE_FLOOR_DBFS, GATE_MARGIN_DB, MEDIAN_N, OCTAVE_ANCHOR_MS } from '../constants';

/** オクターブ跳躍と判定する、アンカーからの最小cent距離。 */
const OCTAVE_JUMP_MIN_CENTS = 700;
/** ±1オクターブ(1200cent)からの許容ズレ。この範囲内のみ「2倍/半分」跳躍とみなす。 */
const OCTAVE_JUMP_TOLERANCE_CENTS = 100;
const OCTAVE_NOMINAL_CENTS = 1200;
/** 跳躍候補がこの回数連続したら、単発ノイズではなく本物の変化と判定してアンカーを切り替える。 */
const OCTAVE_SWITCH_STREAK = 3;
/** silent判定の閾値マージン(noiseFloor設定時: noiseFloorDb+この値未満はsilent)。 */
const SILENT_MARGIN_DB = 3;
/** silent判定の閾値(noiseFloor未設定時: GATE_FLOOR_DBFS - この値未満はsilent)。 */
const SILENT_FLOOR_MARGIN_DB = 10;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

type JumpDirection = 'up' | 'down';

interface AnchorEntry {
  timestampMs: number;
  frequencyHz: number;
}

export class PitchProcessor {
  private noiseFloorDb: number | null = null;

  // --- octave fix state(直近OCTAVE_ANCHOR_MSのvoiced中央値をアンカーとする) ---
  private anchorHistory: AnchorEntry[] = [];
  private jumpDirection: JumpDirection | null = null;
  private jumpStreak = 0;

  // --- median filter state(post-octave-fix voiced周波数の直近MEDIAN_N個) ---
  private medianWindow: number[] = [];
  /** median後・EMA前。voicedでないサンプルの間は直近値を保持する。 */
  private lastScoringHz = 0;

  // --- 表示用EMA state(log2(hz) = centドメインで保持) ---
  private emaLog2Hz: number | null = null;
  private lastDisplayHz = 0;

  /**
   * internalSampleRate は現時点のアルゴリズム(すべてraw.timestampMsのms domainで動作)
   * では内部状態として保持する必要が無いため、フィールドには持たず引数検証のみに使う。
   * 将来sampleIndexベースの計算が必要になった場合はここに保持を追加する。
   */
  constructor(internalSampleRate: number) {
    if (!(internalSampleRate > 0)) {
      throw new Error(`PitchProcessor: internalSampleRate must be positive (got ${internalSampleRate})`);
    }
  }

  /** 環境ノイズ測定の結果を設定(dBFS)。未設定時はGATE_FLOOR_DBFSのみで動作する。 */
  setNoiseFloorDb(db: number): void {
    this.noiseFloorDb = db;
  }

  process(raw: RawPitchSample): ProcessedPitchSample {
    // amplitude=0 は Math.log10(0) === -Infinity により自然に -Infinity 扱いになる。
    const rmsDb = 20 * Math.log10(raw.amplitude);
    const voicing = this.classifyVoicing(rmsDb, raw);

    if (voicing === 'voiced') {
      const correctedHz = this.applyOctaveFix(raw.frequencyHz, raw.timestampMs);
      this.pushMedianWindow(correctedHz);
      this.lastScoringHz = median(this.medianWindow);
      this.updateDisplayEma(this.lastScoringHz);
    }
    // voicedでなければ lastScoringHz / EMA状態は更新しない(直近値を保持)。

    // frequencyHzForScoring<=0(=まだ一度もvoicedになっていない)ならmidiNoteは0固定。
    // voicing側で判別可能なので、-Infinity等の非有用な値を持ち回らせない意図的な選択。
    const midiNote = this.lastScoringHz > 0 ? hzToMidi(this.lastScoringHz) : 0;

    return {
      sampleIndex: raw.sampleIndex,
      timestampMs: raw.timestampMs,
      frequencyHzForScoring: this.lastScoringHz,
      frequencyHzForDisplay: this.lastDisplayHz,
      midiNote,
      voicing,
    };
  }

  /** 全内部状態をクリアする(noiseFloorDbを含む — 再設定は呼び出し側の責務)。 */
  reset(): void {
    this.noiseFloorDb = null;
    this.anchorHistory = [];
    this.jumpDirection = null;
    this.jumpStreak = 0;
    this.medianWindow = [];
    this.lastScoringHz = 0;
    this.emaLog2Hz = null;
    this.lastDisplayHz = 0;
  }

  private classifyVoicing(rmsDb: number, raw: RawPitchSample): Voicing {
    const noiseFloorDb = this.noiseFloorDb;
    const gateDb =
      noiseFloorDb === null
        ? GATE_FLOOR_DBFS
        : Math.max(noiseFloorDb + GATE_MARGIN_DB, GATE_FLOOR_DBFS);
    const silentThreshold =
      noiseFloorDb === null ? GATE_FLOOR_DBFS - SILENT_FLOOR_MARGIN_DB : noiseFloorDb + SILENT_MARGIN_DB;

    if (rmsDb < silentThreshold) return 'silent';
    if (rmsDb < gateDb) return 'tooQuiet';
    if (!raw.belowThreshold || !(raw.frequencyHz > 0)) return 'unclear';
    return 'voiced';
  }

  /**
   * 直近300ms(OCTAVE_ANCHOR_MS)のvoiced中央値をアンカーとし、単発(1〜2サンプル)で
   * 元の高さ帯に戻るオクターブ跳躍のみを補正する。
   *
   * 実装方式(遅延なし): 跳躍検出時はまず補正して出力する。同方向の跳躍候補が
   * OCTAVE_SWITCH_STREAK(3)回連続したら、単発ノイズではなく本物の変化とみなし、
   * アンカー自体を新しい高さへ切り替えて(履歴をクリアして現在値で再シード)、
   * 以降は補正しない(素通し)。これにより「単発は補正・持続は3サンプル目以降素通し」を実現する。
   */
  private applyOctaveFix(frequencyHz: number, timestampMs: number): number {
    this.pruneAnchorHistory(timestampMs);

    if (this.anchorHistory.length === 0) {
      // アンカー(比較対象)がまだ無い: 補正しようがないのでそのまま採用してシードする。
      this.anchorHistory.push({ timestampMs, frequencyHz });
      this.jumpDirection = null;
      this.jumpStreak = 0;
      return frequencyHz;
    }

    const anchor = median(this.anchorHistory.map((e) => e.frequencyHz));
    const deltaCents = 1200 * Math.log2(frequencyHz / anchor);
    const absDelta = Math.abs(deltaCents);
    const isJumpCandidate =
      absDelta >= OCTAVE_JUMP_MIN_CENTS &&
      Math.abs(absDelta - OCTAVE_NOMINAL_CENTS) <= OCTAVE_JUMP_TOLERANCE_CENTS;

    if (!isJumpCandidate) {
      this.jumpDirection = null;
      this.jumpStreak = 0;
      this.anchorHistory.push({ timestampMs, frequencyHz });
      return frequencyHz;
    }

    const direction: JumpDirection = deltaCents > 0 ? 'up' : 'down';
    this.jumpStreak = this.jumpDirection === direction ? this.jumpStreak + 1 : 1;
    this.jumpDirection = direction;

    if (this.jumpStreak >= OCTAVE_SWITCH_STREAK) {
      // 持続的な変化と判定: アンカーを新しい高さへ切り替え、以降は補正しない。
      this.anchorHistory = [{ timestampMs, frequencyHz }];
      return frequencyHz;
    }

    // 単発(1〜2サンプル目)の跳躍: 補正してアンカー帯に戻す。
    // アンカー履歴には積まない(補正中の値でアンカー自体を汚染しないため)。
    return direction === 'up' ? frequencyHz / 2 : frequencyHz * 2;
  }

  private pruneAnchorHistory(nowMs: number): void {
    const cutoff = nowMs - OCTAVE_ANCHOR_MS;
    while (this.anchorHistory.length > 0 && this.anchorHistory[0].timestampMs < cutoff) {
      this.anchorHistory.shift();
    }
  }

  private pushMedianWindow(hz: number): void {
    this.medianWindow.push(hz);
    if (this.medianWindow.length > MEDIAN_N) {
      this.medianWindow.shift();
    }
  }

  /** centドメイン(=log2(hz)ドメイン)でEMAを適用する。Hzドメインで平均してはならない。 */
  private updateDisplayEma(hz: number): void {
    const log2Hz = Math.log2(hz);
    this.emaLog2Hz =
      this.emaLog2Hz === null ? log2Hz : EMA_ALPHA * log2Hz + (1 - EMA_ALPHA) * this.emaLog2Hz;
    this.lastDisplayHz = Math.pow(2, this.emaLog2Hz);
  }
}
