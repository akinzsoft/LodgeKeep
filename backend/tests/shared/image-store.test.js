'use strict';

/**
 * `readImageSize` / `fitInside` — the real pixel size of an uploaded logo,
 * read from the file's own header, and the exact size it is shown at in an
 * email header. The sample images are real files generated with Pillow
 * (PNG 600×200, JPEG 300×300, WebP lossy 500×100, lossless 120×480, and
 * extended-with-alpha 333×77).
 */

const samples = require('./fixtures/sample-images.json');
const { readImageSize, fitInside, sniffImageType } = require('../../src/shared/image-store');

const image = (key) => Buffer.from(samples[key], 'base64');

describe('readImageSize', () => {
  it.each([
    ['png', 'png', 600, 200],
    ['jpg', 'jpg', 300, 300],
    ['webpLossy', 'webp', 500, 100],
    ['webpLossless', 'webp', 120, 480],
    ['webpAlpha', 'webp', 333, 77],
  ])('reads a %s file’s real dimensions', (key, type, width, height) => {
    expect(sniffImageType(image(key))).toBe(type);
    expect(readImageSize(image(key))).toEqual({ width, height });
  });

  it('returns null for something that is not an image', () => {
    expect(readImageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('returns null for a truncated JPEG with no frame header', () => {
    expect(readImageSize(image('jpg').subarray(0, 20))).toBeNull();
  });
});

describe('fitInside', () => {
  it('shrinks a wide logo to the box width, keeping its shape', () => {
    expect(fitInside({ width: 600, height: 200 }, 240, 72)).toEqual({ width: 216, height: 72 });
    expect(fitInside({ width: 1200, height: 100 }, 240, 72)).toEqual({ width: 240, height: 20 });
  });

  it('shrinks a tall or square logo to the box height', () => {
    expect(fitInside({ width: 300, height: 300 }, 240, 72)).toEqual({ width: 72, height: 72 });
    expect(fitInside({ width: 120, height: 480 }, 240, 72)).toEqual({ width: 18, height: 72 });
  });

  it('never enlarges a small logo', () => {
    expect(fitInside({ width: 100, height: 40 }, 240, 72)).toEqual({ width: 100, height: 40 });
  });

  it('returns null without a size', () => {
    expect(fitInside(null, 240, 72)).toBeNull();
  });
});
