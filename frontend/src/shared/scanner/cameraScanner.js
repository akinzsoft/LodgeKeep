/**
 * Phone-camera barcode scanning — the browser plumbing, kept apart from any
 * screen so it can be stubbed in tests (jsdom has no camera or decoder).
 *
 * - `cameraSupported()`: the device can be asked for a camera at all (a secure
 *   context — production is HTTPS, dev is *.localhost — with mediaDevices).
 * - `openCamera(video)`: the MAIN rear camera into a <video>, as a MediaStream
 *   (`srcObject`, never a blob: URL), at up to 1080p with continuous autofocus
 *   where the camera offers it. Failures come back as a `CameraError` with a
 *   `reason` the screen can explain: denied / no_camera / busy / failed.
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

// Camera choice. Phones with several rear lenses often hand a web page the
// ultra-wide, macro or depth lens for `facingMode: environment`; those cannot
// focus close enough to read a barcode. After the first open (when labels are
// readable) the rear lenses are ranked by label, and a lens that reports no
// autofocus is skipped for the next one that has it (labels vary by phone:
// "camera2 0, facing back" on some Android builds, "camera 0, facing back" on
// others — found on a real phone, where the label match alone picked the
// fixed-focus "camera 2"). The choice is remembered on this device.
// The key carries a version: phones that remembered a wrong lens under the
// first key choose again.
const CAMERA_KEY = 'lodgekeep.scanCamera.v2';
const OLD_CAMERA_KEYS = ['lodgekeep.scanCamera'];
const RESOLUTION = { width: { ideal: 1920 }, height: { ideal: 1080 } };
const MAX_LENS_TRIES = 3; // rear lenses opened at most while looking for one with autofocus

function lensScore(label) {
  const text = String(label ?? '').toLowerCase();
  let score = 0;
  if (/ultra|tele|macro|depth|infrared/.test(text)) score -= 10;
  if (/\bcamera2? 0\b/.test(text)) score += 5; // Android: camera id 0 is the main rear camera
  if (/dual wide|triple|^back camera$/.test(text)) score += 3; // iPhone: the auto-switching or main lens
  return score;
}

/** Android's camera id from a label like "camera 2, facing back" (lower is usually the main lens), else Infinity. */
function androidCameraId(label) {
  const match = /\bcamera2? (\d+)\b/i.exec(String(label ?? ''));
  return match ? Number(match[1]) : Infinity;
}

/** The device's rear cameras, best first: by label score, then lowest Android id, then list order. Pure. */
export function rankRearCameras(devices) {
  return devices
    .map((device, index) => ({ device, index }))
    .filter(({ device }) => device.kind === 'videoinput' && /back|rear|environment/i.test(device.label))
    .sort(
      (a, b) =>
        lensScore(b.device.label) - lensScore(a.device.label) ||
        androidCameraId(a.device.label) - androidCameraId(b.device.label) ||
        a.index - b.index,
    )
    .map(({ device }) => device);
}

/** Of the cameras the device lists, the main rear one by label (or null when none is recognisably rear). Pure. */
export function chooseMainRearCamera(devices) {
  return rankRearCameras(devices)[0] ?? null;
}

function rememberedCamera() {
  try {
    for (const key of OLD_CAMERA_KEYS) window.localStorage.removeItem(key);
    return window.localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
}
function rememberCamera(deviceId) {
  try {
    if (deviceId) window.localStorage.setItem(CAMERA_KEY, deviceId);
    else window.localStorage.removeItem(CAMERA_KEY);
  } catch {
    // Blocked storage: the choice simply happens again next time.
  }
}

function requestCamera(choice) {
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...choice, ...RESOLUTION } });
}

/** Continuous autofocus where the camera offers it (many Android phones stay fixed-focus in Chrome unless asked). */
async function enableAutofocus(stream) {
  const track = stream.getVideoTracks?.()[0];
  try {
    if (track?.getCapabilities?.().focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch {
    // The camera keeps its own focus.
  }
}

const RELEASE_DELAY_MS = 250; // Android may refuse a camera for a moment after the previous one stopped
const release = () => new Promise((resolve) => setTimeout(resolve, RELEASE_DELAY_MS));
const deviceIdOf = (stream) => stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId;

/**
 * Whether the stream's camera can autofocus: true, false, or null when the
 * browser does not say (then the label choice is trusted, never probed).
 */
function autofocusOf(stream) {
  try {
    const modes = stream?.getVideoTracks?.()[0]?.getCapabilities?.().focusMode;
    return Array.isArray(modes) ? modes.includes('continuous') : null;
  } catch {
    return null;
  }
}

async function openExact(deviceId) {
  try {
    return await requestCamera({ deviceId: { exact: deviceId } });
  } catch {
    return null;
  }
}

async function openMainRearCamera() {
  const remembered = rememberedCamera();
  if (remembered) {
    try {
      return await requestCamera({ deviceId: { exact: remembered } });
    } catch (error) {
      const reason = reasonFor(error);
      if (reason === 'denied' || reason === 'busy') throw error; // busy is not gone: keep the remembered lens
      rememberCamera(null); // that camera no longer exists: choose again
    }
  }
  let stream = await requestCamera({ facingMode: { ideal: 'environment' } });
  let candidates;
  try {
    candidates = rankRearCameras(await navigator.mediaDevices.enumerateDevices()).filter((device) => device.deviceId);
  } catch {
    return stream; // cannot list cameras: keep the one the browser chose
  }
  if (candidates.length === 0) return stream;

  // Many phones cannot open two cameras at once, so each switch closes the
  // current one first and gives Android a moment to release it.
  async function switchTo(deviceId) {
    if (stream && deviceIdOf(stream) === deviceId) return stream;
    if (stream) {
      closeCamera(stream);
      stream = null;
      await release();
    }
    stream = await openExact(deviceId);
    return stream;
  }

  let fallback = null; // the best-ranked lens that opened, used if none reports autofocus
  for (const candidate of candidates.slice(0, MAX_LENS_TRIES)) {
    if (!(await switchTo(candidate.deviceId))) continue;
    const autofocus = autofocusOf(stream);
    if (autofocus !== false) {
      rememberCamera(candidate.deviceId); // autofocus confirmed, or the browser cannot tell: trust the ranking
      return stream;
    }
    fallback ??= candidate.deviceId;
  }
  if (fallback && (await switchTo(fallback))) {
    rememberCamera(fallback);
    return stream;
  }
  if (stream) return stream;
  // No ranked lens would open: the browser's own choice, without remembering it. If even that
  // fails, the error reaches the screen — never a stopped stream.
  await release();
  return requestCamera({ facingMode: { ideal: 'environment' } });
}

export async function openCamera(video) {
  let stream;
  try {
    stream = await openMainRearCamera();
  } catch (error) {
    throw new CameraError(reasonFor(error), error);
  }
  await enableAutofocus(stream);
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

const MAX_FRAME_WIDTH = 1600;
const READ_TIMEOUT_MS = 3000;
let frameCanvas = null;
let frameCount = 0;

/**
 * The part of the video to decode: usually the centre band where the aiming
 * box is, at full detail (a barcode filling the box gets the most pixels per
 * bar); every third read the whole frame, for a barcode held off-centre or
 * sideways. Scaled down only past 1600 px wide.
 */
function frameRegion(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  frameCount += 1;
  if (frameCount % 3 === 0) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const sw = Math.round(vw * 0.9);
  const sh = Math.min(vh, Math.round(sw * 0.6));
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Decoding took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The first barcode value in the current video frame, or null. Never throws (a
 * bad frame is just skipped; repeated failures are counted in `stats` for the
 * screen to report). The region is drawn onto one reused canvas and the canvas
 * is decoded — the path verified in a real browser; handing the decoder a
 * media element directly was not reliable there.
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
    const { sx, sy, sw, sh } = frameRegion(video);
    const scale = Math.min(1, MAX_FRAME_WIDTH / sw);
    frameCanvas ??= document.createElement('canvas');
    frameCanvas.width = Math.round(sw * scale);
    frameCanvas.height = Math.round(sh * scale);
    frameCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, frameCanvas.width, frameCanvas.height);
    // A read that never answers must not stop scanning: it is abandoned after 3 s.
    const found = await withTimeout(detector.detect(frameCanvas), READ_TIMEOUT_MS);
    const code = found.find((entry) => entry.rawValue)?.rawValue ?? null;
    if (stats) {
      stats.completed += 1;
      stats.consecutiveErrors = 0;
      if (code) stats.lastCode = code;
      else stats.empty += 1;
    }
    return code;
  } catch (error) {
    if (stats) {
      stats.errors += 1;
      stats.consecutiveErrors += 1;
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
  return { notReady: 0, attempts: 0, completed: 0, empty: 0, errors: 0, consecutiveErrors: 0, lastError: null, lastMs: null, lastCode: null, frameSize: null, inFlightSince: null };
}
