import { describe, expect, it } from 'vitest';
import { centsBetween, hzToMidi, midiToHz, midiToNoteName } from './conversions';

describe('hzToMidi', () => {
  it.each([
    [440, 69],
    [880, 81],
    [220, 57],
    [261.6255653, 60], // C4
  ])('hzToMidi(%f) ≈ %f', (hz, expectedMidi) => {
    expect(hzToMidi(hz)).toBeCloseTo(expectedMidi, 4);
  });
});

describe('midiToHz', () => {
  it.each([
    [69, 440],
    [81, 880],
    [57, 220],
    [60, 261.6255653],
  ])('midiToHz(%f) ≈ %f', (midi, expectedHz) => {
    expect(midiToHz(midi)).toBeCloseTo(expectedHz, 3);
  });

  it('is the inverse of hzToMidi over a range of frequencies', () => {
    for (const hz of [80, 130, 220, 261.63, 440, 523.25, 700]) {
      expect(midiToHz(hzToMidi(hz))).toBeCloseTo(hz, 6);
    }
  });
});

describe('centsBetween', () => {
  it.each([
    [880, 440, 1200],
    [440, 880, -1200],
    [440, 440, 0],
    [440 * Math.pow(2, 7 / 12), 440, 700], // perfect fifth
  ])('centsBetween(%f, %f) ≈ %f', (userHz, targetHz, expectedCents) => {
    expect(centsBetween(userHz, targetHz)).toBeCloseTo(expectedCents, 4);
  });
});

describe('midiToNoteName', () => {
  it.each([
    [69, 'A4'],
    [60, 'C4'],
    [57, 'A3'],
    [81, 'A5'],
    [0, 'C-1'],
    [12, 'C0'],
    [70, 'A#4'],
    [59, 'B3'],
  ])('midiToNoteName(%i) = %s', (midi, expectedName) => {
    expect(midiToNoteName(midi)).toBe(expectedName);
  });

  it('rounds to the nearest note name for non-integer MIDI values', () => {
    expect(midiToNoteName(69.4)).toBe('A4');
    expect(midiToNoteName(69.6)).toBe('A#4');
  });
});
