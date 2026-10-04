/**
 * The barcode decoder — loaded only when the camera scanner opens (a dynamic
 * import from cameraScanner.js), so the till itself stays small.
 *
 * `barcode-detector` is a ponyfill of the browser's BarcodeDetector API built
 * on ZXing-C++ compiled to WebAssembly. It is used on every phone, not only
 * where the browser lacks the native API (iOS has none), so every device reads
 * the same way. By default it would fetch its .wasm from jsDelivr; this app
 * never loads code from a CDN, so `locateFile` points it at the copy Vite
 * emits into our own /assets (content-hashed, cached immutably). Production's
 * CSP allows compiling it via `'wasm-unsafe-eval'` (docker/frontend/Caddyfile).
 */
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** Retail and common shelf-label symbologies; QR is left out (not a product barcode). */
export const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

/** Instantiates the decoder (fetching the self-hosted .wasm) and returns a detector. Rejects if it cannot load. */
export async function createDetector() {
  await prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  return new BarcodeDetector({ formats: SCAN_FORMATS });
}
