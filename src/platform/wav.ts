// WAV(mono, 16bit PCM)エンコード。録音・再生ハーネス(audioSession.ts の録音タップ)の
// 出力をダウンロード可能な形にするための platform 層ユーティリティ。
// core/ではなくここに置く理由: Blob は DOM/Web API であり core は DOM 禁止(AGENTS.md)。

/**
 * Float32Array(範囲[-1,1]想定。外れた値は clamp)を mono 16bit PCM WAV の Blob にエンコードする。
 * 標準的な44バイトRIFFヘッダ + データチャンクのみ(拡張チャンクなし)。
 */
export function encodeWavPcm16(pcm: Float32Array, sampleRate: number): Blob {
  if (!(sampleRate > 0)) {
    throw new Error(`encodeWavPcm16: sampleRate must be positive (got ${sampleRate})`);
  }

  const bytesPerSample = 2; // 16bit
  const numChannels = 1; // mono
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmtチャンクサイズ(PCM)
  view.setUint16(20, 1, true); // audioFormat = 1(PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bitsPerSample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    // [-1,1]にclampしてから16bit整数レンジへスケール(負側は-32768まで、正側は32767まで)。
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(scaled), true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
