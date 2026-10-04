import { describe, it, expect, vi } from 'vitest';

const ponyfill = vi.hoisted(() => ({
  prepareZXingModule: vi.fn().mockResolvedValue({}),
  BarcodeDetector: vi.fn(function FakeDetector(options) {
    this.options = options;
  }),
}));
vi.mock('barcode-detector/ponyfill', () => ponyfill);

describe('createDetector', () => {
  it('loads the decoder from our own copy of the .wasm, never a CDN, and reads retail barcodes', async () => {
    const { createDetector, SCAN_FORMATS } = await import('../detector.js');
    const detector = await createDetector();

    const { overrides, fireImmediately } = ponyfill.prepareZXingModule.mock.calls[0][0];
    expect(fireImmediately).toBe(true);
    const wasm = overrides.locateFile('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm/dist/reader/');
    expect(wasm).toMatch(/zxing_reader.*\.wasm/);
    expect(wasm).not.toMatch(/jsdelivr|^https?:/);
    expect(overrides.locateFile('other.js', '/prefix/')).toBe('/prefix/other.js');

    expect(detector.options.formats).toEqual(SCAN_FORMATS);
    expect(SCAN_FORMATS).toEqual(expect.arrayContaining(['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']));
  });
});
