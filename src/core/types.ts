// 中核データ型の正本は docs/ARCHITECTURE.md。変更時は必ず両方を同期させること。
// このファイルを含む src/core/ は DOM / Web Audio / React に依存しない(純TS)。
// 全型は structured clone / transfer 可能な単純型のみで構成する(Worker境界を跨ぐため)。

export type Voicing = 'voiced' | 'silent' | 'tooQuiet' | 'unclear';

export interface RawPitchSample {
  /** 録音ストリームのサンプル位置(内部レート基準)。壁時計時刻の代入禁止 */
  sampleIndex: number;
  /** sampleIndex から導出 */
  timestampMs: number;
  /** 0 = 候補なし */
  frequencyHz: number;
  /** YIN絶対閾値を通過したか。voicing判定の一次情報 */
  belowThreshold: boolean;
  /** 0..1(clamp済)。スケールは検出器固有 — 検出器間で比較不能 */
  confidence: number;
  /** RMS(ホップ単位、DC除去後) */
  amplitude: number;
}

export interface ProcessedPitchSample {
  sampleIndex: number;
  timestampMs: number;
  /** median後・EMA前。採点はこちら */
  frequencyHzForScoring: number;
  /** EMA後(centドメイン)。表示専用 */
  frequencyHzForDisplay: number;
  /** ForScoring から導出、実数 */
  midiNote: number;
  voicing: Voicing;
}

/** ストリーム型検出器。YIN=push即返し、pYIN=遅延出力も同一契約(ADR-001) */
export interface PitchDetector {
  reset(): void;
  push(hop: Float32Array): RawPitchSample | null;
  flush(): RawPitchSample[];
}

export interface TargetNote {
  midiNote: number;
  startMs: number;
  durationMs: number;
}

export interface ExerciseSpec {
  exerciseId: string;
  levelId: string;
  /** MVP(Level 2)は1要素。Level 3/4 でそのまま伸びる */
  targets: TargetNote[];
  phonationMaxMs: number;
  guardAfterPlaybackMs: number;
}

export type ValidityReason = 'ok' | 'tooShort' | 'tooQuiet';

export interface ExerciseMetrics {
  pitchAccuracy: number;
  /** 連続量(履歴・進捗用) */
  medianAbsCents: number;
  /** null = 測定不能(目標未到達)。0にしない */
  pitchStability: number | null;
  /** null = 測定不能(一度も±50centに入らず)。0にしない */
  attackAccuracy: number | null;
  /** 型のみ。Level 3 まで算出しない */
  intervalAccuracy?: number | null;
  /** 型のみ。Level 1 まで算出しない */
  directionAccuracy?: number | null;
}

export interface ExerciseResult {
  /** 実施時のスナップショット(過去結果を後から再解釈可能に) */
  spec: ExerciseSpec;
  timestamp: number;
  /** 指標算出パラメータのバージョン。バージョン跨ぎの履歴比較禁止 */
  paramsVersion: number;
  validity: { isValid: boolean; reason: ValidityReason };
  metrics: ExerciseMetrics;
  /** 持続的オクターブ差の診断。処理層で補正しない */
  octaveOff: -1 | 0 | 1;
  /** MVPはメモリ内のみ。永続化は Storage ADR まで禁止 */
  samples: ProcessedPitchSample[];
}

export interface Diagnosis {
  primaryWeakness: keyof ExerciseMetrics | null;
  octaveOff: -1 | 0 | 1;
  /** 僅差判定時 false → 前回の提案を維持(ヒステリシス) */
  isReliable: boolean;
  /** ルールID(将来AIの説明素材) */
  rationale: string;
}

export interface SkillSnapshot {
  skillId: string;
  value: number;
  /** ISO 8601 */
  date: string;
  exerciseId: string;
  paramsVersion: number;
}
