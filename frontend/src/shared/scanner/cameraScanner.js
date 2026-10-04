/**
 * Phone-camera barcode scanning — the browser plumbing, kept apart from any
 * screen so it can be stubbed in tests (jsdom has no camera or decoder).
 *
 * - `cameraSupported()`: the device can be asked for a camera at all (a secure
 *   context — production is HTTPS, dev is *.localhost — with mediaDevices).
 * - `openCamera(video)`: the rear camera into a <video>, as a MediaStream
 *   (`srcObject`, never a blob: URL). Failures come back as a `CameraError`
 *   with a `reason` the screen can explain: denied / no_camera / busy / failed.
 * - `loadDetector()`: the decoder, imported on demand (see detector.js).
 * - `closeCamera(stream)`: stops every track, so the camera light goes off.
 */

export class CameraError extends Error {
  constructor(reason, cause) {
    super(reason);
    this.name = 'CameraError';
    this.reason = reason;
    this.cause = cause;
  }
}

export function cameraSupported() {
  return typeof window !== 'undefined' && window.isSecureContext !== false && typeof navigator?.mediaDevices?.getUserMedia === 'function';
}

function reasonFor(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no_camera';
    case 'NotReadableError':
    case 'AbortError':
      return 'busy';
    default:
      return 'failed';
  }
}

export async function openCamera(video) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (error) {
    throw new CameraError(reasonFor(error), error);
  }
  try {
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    closeCamera(stream);
    throw new CameraError('failed', error);
  }
  return stream;
}

export function closeCamera(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

/** Whether the camera offers a light (most Android phones; not iOS Safari). */
export function torchSupported(stream) {
  const track = stream?.getVideoTracks?.()[0];
  try {
    return Boolean(track?.getCapabilities?.().torch);
  } catch {
    return false;
  }
}

export async function setTorch(stream, on) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

let detectorPromise = null;
const decoder = { state: 'idle', loadMs: null, wasmUrl: null, error: null };

/** The decoder, loaded once per page; a failed load is retried on the next open. */
export function loadDetector() {
  if (!detectorPromise) {
    const started = Date.now();
    Object.assign(decoder, { state: 'loading', loadMs: null, error: null });
    detectorPromise = import('./detector.js')
      .then(async ({ createDetector, WASM_URL }) => {
        decoder.wasmUrl = WASM_URL;
        const created = await createDetector();
        Object.assign(decoder, { state: 'ready', loadMs: Date.now() - started });
        return created;
      })
      .catch((error) => {
        detectorPromise = null;
        Object.assign(decoder, { state: 'failed', loadMs: Date.now() - started, error: String(error?.message ?? error) });
        throw new CameraError('decoder', error);
      });
  }
  return detectorPromise;
}

// ---------------------------------------------------------------- diagnostics (?scandebug=1)

/** The decoder's load state, for the on-screen debug panel. */
export function decoderInfo() {
  return { ...decoder };
}

/** Which camera the stream really is, what it delivers and what it supports — JSON-safe, for the debug panel. */
export function describeCamera(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return null;
  const safe = (read) => {
    try {
      return read() ?? null;
    } catch {
      return null;
    }
  };
  const capabilities = safe(() => track.getCapabilities?.());
  return {
    label: track.label,
    state: track.readyState,
    muted: track.muted,
    settings: safe(() => track.getSettings()),
    capabilities: capabilities && {
      facingMode: capabilities.facingMode,
      focusMode: capabilities.focusMode,
      width: capabilities.width,
      height: capabilities.height,
      zoom: capabilities.zoom,
      torch: capabilities.torch,
    },
  };
}

/** Every camera the device lists (labels appear once permission is granted). */
export async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput').map((device) => device.label || '(no label)');
  } catch (error) {
    return [`(could not list: ${error?.message ?? error})`];
  }
}

/** The canvas the last frame was drawn on (what the decoder actually saw), or null. */
export function lastFrame() {
  return frameCanvas;
}

const MAX_FRAME_WIDTH = 1280;
let frameCanvas = null;

/**
 * The first barcode value in the current video frame, or null. Never throws (a
 * bad frame is just skipped). The frame is drawn onto one reused canvas (at most
 * 1280 px wide) and the canvas is decoded — the path verified in a real browser;
 * handing the decoder a media element directly was not reliable there.
 */
export async function readFrame(detector, video, stats = null) {
  if (!video || video.readyState < 2 || !video.videoWidth) {
    if (stats) stats.notReady += 1;
    return null;
  }
  const started = Date.now();
  if (stats) {
    stats.attempts += 1;
    stats.inFlightSince = started;
  }
  try {
    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    frameCanvas ??= document.createElement('canvas');
    frameCanvas.width = Math.round(video.videoWidth * scale);
    frameCanvas.height = Math.round(video.videoHeight * scale);
    frameCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const found = await detector.detect(frameCanvas);
    const code = found.find((entry) => entry.rawValue)?.rawValue ?? null;
    if (stats) {
      stats.completed += 1;
      if (code) stats.lastCode = code;
      else stats.empty += 1;
    }
    return code;
  } catch (error) {
    if (stats) {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
    }
    return null;
  } finally {
    if (stats) {
      stats.lastMs = Date.now() - started;
      stats.frameSize = frameCanvas ? `${frameCanvas.width}\u00d7${frameCanvas.height}` : null;
      stats.inFlightSince = null;
    }
  }
}

/** A fresh counter set for `readFrame(..., stats)`. */
export function newScanStats() {
  return { notReady: 0, attempts: 0, completed: 0, empty: 0, errors: 0, lastError: null, lastMs: null, lastCode: null, frameSize: null, inFlightSince: null };
}
