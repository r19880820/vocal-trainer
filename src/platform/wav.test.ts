import { describe, expect, it } from 'vitest';
import { encodeWavPcm16 } from './wav';

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** encodeWavPcm16 と同じ clamp+scale+round 規則で期待値を計算する(浮動小数の丸め方式に依存しないため)。 */
function expectedInt16(x: number): number {
  const clamped = Math.max(-1, Math.min(1, x));
  const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  return Math.round(scaled);
}

describe('encodeWavPcm16', () => {
  it('mono 16bit PCM WAVの44バイトヘッダを正しく書く', async () => {
    const sampleRate = 48000;
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavPcm16(pcm, sampleRate);
    expect(blob.type).toBe('audio/wav');

    const buf = await blob.arrayBuffer();
    expect(buf.byteLength).toBe(44 + pcm.length * 2);
    const view = new DataView(buf);

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2); // ChunkSize
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size (PCM)
    expect(view.getUint16(20, true)).toBe(1); // audioFormat = PCM
    expect(view.getUint16(22, true)).toBe(1); // numChannels = mono
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byteRate = sampleRate * blockAlign(2)
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    expect(readAscii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.length * 2); // dataSize
  });

  it('サンプル値を正しくスケール・クランプしてint16 PCMに書く', async () => {
    const values = [0, 0.5, -0.5, 1, -1, 2, -2]; // 2, -2 は範囲外→クランプ確認
    const pcm = new Float32Array(values);
    const blob = encodeWavPcm16(pcm, 44100);
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);

    values.forEach((v, i) => {
      expect(view.getInt16(44 + i * 2, true)).toBe(expectedInt16(v));
    });
    // 範囲外値は ±32767/-32768 にクランプされる
    expect(view.getInt16(44 + 5 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 6 * 2, true)).toBe(-0x8000);
  });

  it('sampleRateが0以下ならfail-loudでthrowする', () => {
    expect(() => encodeWavPcm16(new Float32Array(1), 0)).toThrow(/sampleRate/);
    expect(() => encodeWavPcm16(new Float32Array(1), -1)).toThrow(/sampleRate/);
  });

  it('空のPCM配列はヘッダのみ(dataSize=0)のBlobになる', async () => {
    const blob = encodeWavPcm16(new Float32Array(0), 48000);
    const buf = await blob.arrayBuffer();
    expect(buf.byteLength).toBe(44);
    const view = new DataView(buf);
    expect(view.getUint32(40, true)).toBe(0);
  });
});
