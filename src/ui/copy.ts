// UI文言の実装。正本は docs/UX_TRAINING.md §2〜3 — 文言変更は必ず先に正本を更新すること。
import type { ExerciseOutcome } from '../core/exercise/engine';
import type { ExerciseResult } from '../core/types';
import { centsBetween, midiToHz } from '../core/pitch/conversions';
// 方向付きアドバイスの発動閾値。従来は ZONE_NEAR_CENTS(100)を流用していたが、
// 実ユーザーの一貫した+70cent傾向で発動しなかったため独立の閾値に分離(2026-08-16。
// UX_TRAINING §3.2b / AUDIO_ANALYSIS §8 と同期)
const BIAS_HINT_CENTS = 60;

/**
 * 目標に対する符号付きズレの中央値(cent)。負=お手本より低め、正=高め。
 * 「何が難しいのか分からない」への回答材料(2026-08-16 ユーザーフィードバック):
 * 結果の傾向説明と方向付きアドバイスに使う。voiced が無ければ null。
 */
export function signedMedianCentsVsTarget(result: ExerciseResult): number | null {
  const targetHz = midiToHz(result.spec.targets[0].midiNote);
  const cents = result.samples
    .filter((s) => s.voicing === 'voiced')
    .map((s) => centsBetween(s.frequencyHzForScoring, targetHz))
    .sort((a, b) => a - b);
  if (cents.length === 0) return null;
  const mid = cents.length >> 1;
  return cents.length % 2 ? cents[mid] : (cents[mid - 1] + cents[mid]) / 2;
}

export interface ResultCopy {
  praise: string;
  headline: string; // 「次は「{headline}」を練習しましょう」
  action: string;
}

function strength(v: number): string {
  return v >= 0.85 ? 'とても' : 'かなり';
}

/** §3.1 褒めポイント選定: 弱点以外で最も高い指標(≥0.7)。なければ取り組み自体を褒める */
function pickPraise(outcome: ExerciseOutcome): string {
  const m = outcome.result.metrics;
  const weakness = outcome.next.reasonKey;
  const candidates: Array<{ key: string; value: number; text: (v: number) => string }> = [
    { key: 'pitchAccuracy', value: m.pitchAccuracy, text: (v) => `音の高さが${strength(v)}合っています。` },
    {
      key: 'pitchStability',
      value: m.pitchStability ?? -1,
      text: (v) => `声が${strength(v)}安定して伸ばせています。`,
    },
    { key: 'attackAccuracy', value: m.attackAccuracy ?? -1, text: (v) => `音の入りが${strength(v)}良いです。` },
  ];
  const best = candidates
    .filter((c) => c.key !== weakness && c.value >= 0.7)
    .sort((a, b) => b.value - a.value)[0];
  return best ? best.text(best.value) : '最後まで声を出し切りましたね。';
}

export function resultCopy(outcome: ExerciseOutcome): ResultCopy {
  const { result, next } = outcome;
  switch (next.reasonKey) {
    case 'octaveOff': {
      // 「高い声で出せ」は音域外で物理的に不可能な場合があるため使わない(UX §3.5b 裁定)
      const low = result.octaveOff === -1;
      return {
        praise: '音の高さの感覚はしっかり合っています。',
        headline: '声の高さの位置',
        action: low
          ? 'いまはお手本よりひとまわり低い声で歌えています。次はあなたの声に合わせた高さのお手本で練習しましょう(慣れてきたら少しずつ上げていきます)'
          : 'いまはお手本よりひとまわり高い声で歌えています。次はあなたの声に合わせた高さのお手本で練習しましょう(慣れてきたら少しずつ下げていきます)',
      };
    }
    case 'allGood':
      return {
        praise: 'すべてとても良くできています!',
        headline: 'つぎの音',
        action: 'この調子で、少し違う高さの音でも試してみましょう',
      };
    case 'reachTarget':
      return {
        praise: '最後まで声を出し切りましたね。',
        headline: '音を探す',
        action:
          '声の高さを下から上へゆっくり変えながら、お手本と同じ高さを探してみましょう。もう少し出しやすい高さのお手本から始めます',
      };
    case 'retry': {
      if (result.validity.reason === 'tooShort') {
        return {
          praise: '声を出そうとしてくれてありがとうございます。',
          headline: '声を伸ばす長さ',
          action: '一度出した声を、3秒くらい伸ばしたままキープしてみましょう',
        };
      }
      if (result.validity.reason === 'tooQuiet') {
        return {
          praise: '声を出そうとしてくれてありがとうございます。',
          headline: '声の大きさ',
          action: 'マイクに向かって、もう少しはっきり「んー」と声を出してみてください',
        };
      }
      // validity=ok での retry は本来到達不能(レビューm-4)。汎用文言でフォールバック
      return {
        praise: '声を出そうとしてくれてありがとうございます。',
        headline: '声の届け方',
        action: 'マイクの近くで、はっきり・長めに「んー」と声を出してみましょう',
      };
    }
    case 'pitchStability':
      return {
        praise: pickPraise(outcome),
        headline: '声の安定',
        action: '音を出したら、揺れないように一定の高さのままキープしてみましょう',
      };
    case 'attackAccuracy':
      return {
        praise: pickPraise(outcome),
        headline: '音の入り',
        action: '最初から目標の高さを頭の中でイメージしてから、パッと声を出してみましょう',
      };
    case 'pitchAccuracy':
    default: {
      // ズレの方向が一貫している場合は方向付きのアドバイスにする(UX §3.2b)
      const bias = result.octaveOff === 0 ? signedMedianCentsVsTarget(result) : null;
      let action = 'お手本をよく聞いてから、同じ高さになるように意識して声を伸ばしてみましょう';
      if (bias !== null && bias <= -BIAS_HINT_CENTS) {
        action = 'お手本より低くなりやすいようです。思っているより少し高めをねらって声を出してみましょう';
      } else if (bias !== null && bias >= BIAS_HINT_CENTS) {
        action = 'お手本より高くなりやすいようです。力を抜いて、思っているより少し低めをそっとねらってみましょう';
      }
      return {
        praise: pickPraise(outcome),
        headline: '音の高さ',
        action,
      };
    }
  }
}

// SC-4 状態テキスト(§2 SC-4)
export function liveStatusText(cents: number | null, voicing: string, phase: 'playing' | 'waiting' | 'active'): string {
  if (phase === 'playing') return 'お手本を聞いてください 🔊';
  if (phase === 'waiting' || cents === null || voicing !== 'voiced') {
    return phase === 'waiting' ? '同じ高さで「んー」と声を出してみましょう' : '聞こえていません';
  }
  const a = Math.abs(cents);
  if (a <= 50) return '合っています ◎';
  if (a <= 100) return cents < 0 ? '少し低いです ↑もう少し高く' : '少し高いです ↓もう少し低く';
  return cents < 0 ? '低いです ↑もっと高く' : '高いです ↓もっと低く';
}
