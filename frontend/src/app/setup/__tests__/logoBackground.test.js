import { describe, it, expect } from 'vitest';
import { hasSolidBackground } from '../logoBackground.js';

// A 2×2 image: each pixel is [r, g, b, a].
function pixels(...alphas) {
  return new Uint8ClampedArray(alphas.flatMap((a) => [255, 255, 255, a]));
}

describe('hasSolidBackground', () => {
  it('is true when all four corners are fully opaque (a flat JPG-style export)', () => {
    expect(hasSolidBackground(pixels(255, 255, 255, 255), 2, 2)).toBe(true);
  });

  it('is false when any corner is see-through (a transparent PNG)', () => {
    expect(hasSolidBackground(pixels(0, 255, 255, 255), 2, 2)).toBe(false);
    expect(hasSolidBackground(pixels(255, 255, 255, 128), 2, 2)).toBe(false);
  });

  it('is false for missing or empty image data', () => {
    expect(hasSolidBackground(null, 2, 2)).toBe(false);
    expect(hasSolidBackground(pixels(), 0, 0)).toBe(false);
  });
});
