// ローカル設定(声域・初回フラグ)。SkillSnapshot等の履歴永続化は Storage ADR(Phase 7)まで禁止 —
// ここは設定のみを扱う。
import type { VoiceRange } from '../core/exercise/level2';

const KEY = 'vt.settings.v1';

export interface Settings {
  range: VoiceRange | null;
  firstRunDone: boolean;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { range: null, firstRunDone: false, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 破損時は初期値
  }
  return { range: null, firstRunDone: false };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // プライベートブラウズ等で失敗しても続行(設定は毎回聞けばよい)
  }
}
