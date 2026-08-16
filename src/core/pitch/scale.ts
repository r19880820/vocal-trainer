// ハ長調(Cメジャー)スケール上の音への制約(2026-08-16 ユーザーフィードバック起点)。
// 目標音に半音階(黒鍵)を混ぜると初心者の耳に不自然なため、Level 2 の目標と
// Training Recommendation の生成する目標は必ずスケール上の音にする(TRAINING_MODEL.md)。
const C_MAJOR_PCS = new Set([0, 2, 4, 5, 7, 9, 11]); // ド レ ミ ファ ソ ラ シ

function isCMajor(midi: number): boolean {
  return C_MAJOR_PCS.has(((midi % 12) + 12) % 12);
}

/** 最も近いハ長調スケール音へスナップ(同距離なら低い方=出しやすい方を優先) */
export function snapToCMajor(midi: number): number {
  const rounded = Math.round(midi);
  for (let d = 0; d <= 6; d++) {
    if (isCMajor(rounded - d)) return rounded - d;
    if (isCMajor(rounded + d)) return rounded + d;
  }
  return rounded; // 到達しない(スケール音は半音6個以内に必ず存在)
}

/** midi より上で最も近いハ長調スケール音(allGood の「つぎの音」用) */
export function nextCMajorAbove(midi: number): number {
  let m = Math.round(midi) + 1;
  while (!isCMajor(m)) m += 1;
  return m;
}
