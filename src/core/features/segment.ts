// 発声セグメント分割・目標との cents 算出。正本は docs/AUDIO_ANALYSIS.md §5(評価指標の定義)。
// features/ は processing の出力(ProcessedPitchSample)と TargetTrack を突き合わせる層
// (ARCHITECTURE.md 原則5: 処理層は目標非依存、cents 算出はここで行う)。

import type { ProcessedPitchSample } from '../types';
import { midiToHz } from '../pitch/conversions';
import { ONSET_MIN_VOICED_MS } from '../constants';

export interface PhonationSegment {
  /** voicing==='voiced' が連続 ONSET_MIN_VOICED_MS 以上続いた最初の区間の【先頭】timestampMs。
   *  見つからなければ null(§5: 遡及 — 150ms経過時点ではなく区間の先頭)。 */
  onsetMs: number | null;
  /** voiced サンプルの合計時間(ms)。サンプル間隔は timestampMs 差から推定する。 */
  voicedMs: number;
  samples: ProcessedPitchSample[];
}

/**
 * サンプル列から発声区間(onset・voicedMs)を求める純関数。
 */
export function analyzePhonation(samples: ProcessedPitchSample[]): PhonationSegment {
  const durations = sampleDurationsMs(samples);

  let voicedMs = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing === 'voiced') voicedMs += durations[i];
  }

  return {
    onsetMs: findOnsetMs(samples, durations),
    voicedMs,
    samples,
  };
}

/**
 * userHz が targetMidi に対して何 cent ずれているか。
 * cents = 1200 * log2(frequencyHzForScoring / midiToHz(targetMidi))(AUDIO_ANALYSIS.md §4)。
 */
export function centsVsTarget(sample: ProcessedPitchSample, targetMidi: number): number {
  return 1200 * Math.log2(sample.frequencyHzForScoring / midiToHz(targetMidi));
}

/**
 * 各サンプルが表す時間幅(ms)を timestampMs の差から推定する。
 * サンプル i (i>=1) の幅は「直前サンプルからの間隔」(t[i]-t[i-1])。
 * 先頭(i=0)は直前が存在しないため、隣接(次)の間隔で近似する(仕様書の指示どおり)。
 * サンプルが1件以下の場合は幅不明として 0 を返す。
 */
export function sampleDurationsMs(samples: ProcessedPitchSample[]): number[] {
  const n = samples.length;
  const durations = new Array<number>(n).fill(0);
  if (n < 2) return durations;
  durations[0] = samples[1].timestampMs - samples[0].timestampMs;
  for (let i = 1; i < n; i++) {
    durations[i] = samples[i].timestampMs - samples[i - 1].timestampMs;
  }
  return durations;
}

/**
 * voicing==='voiced' が連続で ONSET_MIN_VOICED_MS 以上続く最初の区間を探し、
 * その区間の先頭サンプルの timestampMs を返す(遡及)。見つからなければ null。
 */
function findOnsetMs(samples: ProcessedPitchSample[], durations: number[]): number | null {
  let runStartIdx: number | null = null;
  let runDurationMs = 0;

  for (let i = 0; i < samples.length; i++) {
    if (samples[i].voicing === 'voiced') {
      if (runStartIdx === null) {
        runStartIdx = i;
        runDurationMs = 0;
      }
      runDurationMs += durations[i];
      if (runDurationMs >= ONSET_MIN_VOICED_MS) {
        return samples[runStartIdx].timestampMs;
      }
    } else {
      runStartIdx = null;
      runDurationMs = 0;
    }
  }

  return null;
}
