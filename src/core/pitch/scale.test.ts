import { describe, expect, it } from 'vitest';
import { nextCMajorAbove, snapToCMajor } from './scale';

describe('snapToCMajor', () => {
  it('keeps scale notes unchanged', () => {
    // C3=48, D3=50, E3=52, F3=53, G3=55, A3=57, B3=59, C4=60
    for (const m of [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69]) {
      expect(snapToCMajor(m)).toBe(m);
    }
  });

  it('snaps black keys to the nearest scale note, preferring the lower one on ties', () => {
    expect(snapToCMajor(49)).toBe(48); // C#3 → C3(C/Dと等距離 → 低い方)
    expect(snapToCMajor(51)).toBe(50); // D#3 → D3(D/Eと等距離 → 低い方)
    expect(snapToCMajor(54)).toBe(53); // F#3 → F3
    expect(snapToCMajor(56)).toBe(55); // G#3 → G3
    expect(snapToCMajor(58)).toBe(57); // A#3 → A3
  });

  it('accepts fractional midi (user median pitch)', () => {
    expect(snapToCMajor(57.4)).toBe(57);
    expect(snapToCMajor(58.6)).toBe(59);
  });
});

describe('midiToSolfege', () => {
  it('maps scale notes to solfege names', async () => {
    const { midiToSolfege } = await import('./scale');
    expect(midiToSolfege(48)).toBe('ド');
    expect(midiToSolfege(55)).toBe('ソ');
    expect(midiToSolfege(57)).toBe('ラ');
    expect(midiToSolfege(60)).toBe('ド');
    expect(midiToSolfege(64)).toBe('ミ');
    expect(midiToSolfege(54)).toBe('ファ#');
  });
});

describe('nextCMajorAbove', () => {
  it('returns the next scale degree above', () => {
    expect(nextCMajorAbove(48)).toBe(50); // ド → レ
    expect(nextCMajorAbove(52)).toBe(53); // ミ → ファ(半音上がスケール音)
    expect(nextCMajorAbove(59)).toBe(60); // シ → ド
    expect(nextCMajorAbove(49)).toBe(50); // 黒鍵からでも上のスケール音
  });
});
