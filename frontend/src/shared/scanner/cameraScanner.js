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

/** The decoder, loaded once per page; a failed load is retried on the next open. */
export function loadDetector() {
  detectorPromise ??= import('./detector.js')
    .then(({ createDetector }) => createDetector())
    .catch((error) => {
      detectorPromise = null;
      throw new CameraError('decoder', error);
    });
  return detectorPromise;
}

const MAX_FRAME_WIDTH = 1280;
let frameCanvas = null;

/**
 * The first barcode value in the current video frame, or null. Never throws (a
 * bad frame is just skipped). The frame is drawn onto one reused canvas (at most
 * 1280 px wide) and the canvas is decoded — the path verified in a real browser;
 * handing the decoder a media element directly was not reliable there.
 */
export async function readFrame(detector, video) {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  try {
    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    frameCanvas ??= document.createElement('canvas');
    frameCanvas.width = Math.round(video.videoWidth * scale);
    frameCanvas.height = Math.round(video.videoHeight * scale);
    frameCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const found = await detector.detect(frameCanvas);
    return found.find((entry) => entry.rawValue)?.rawValue ?? null;
  } catch {
    return null;
  }
}
