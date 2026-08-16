// ローカル設定(声域・初回フラグ)。SkillSnapshot等の履歴永続化は Storage ADR(Phase 7)まで禁止 —
// ここは設定のみを扱う。
import type { VoiceRange } from '../core/exercise/level2';

const KEY = 'vt.settings.v1';

export interface Settings {
  range: VoiceRange | null;
  firstRunDone: boolean;
  // 音域チェック(Range Check)の測定結果。TRAINING_MODEL.md「音域チェック」。
  // 旧保存データ(音域チェック実装前)には無いフィールドなので、読込時は必ずnullへデフォルトする。
  rangeComfortLowMidi: number | null;
  rangeComfortHighMidi: number | null;
  rangeFullLowMidi: number | null;
  rangeFullHighMidi: number | null;
  /** ISO 8601。null = 未測定 */
  rangeMeasuredAt: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  range: null,
  firstRunDone: false,
  rangeComfortLowMidi: null,
  rangeComfortHighMidi: null,
  rangeFullLowMidi: null,
  rangeFullHighMidi: null,
  rangeMeasuredAt: null,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 破損時は初期値
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // プライベートブラウズ等で失敗しても続行(設定は毎回聞けばよい)
  }
}
