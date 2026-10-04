import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const detectorModule = vi.hoisted(() => ({ createDetector: vi.fn(), WASM_URL: '/assets/zxing_reader-test.wasm' }));
vi.mock('../detector.js', () => detectorModule);

const fakeTrack = () => ({ stop: vi.fn(), getCapabilities: vi.fn(() => ({})), applyConstraints: vi.fn().mockResolvedValue() });
const fakeStream = (track = fakeTrack()) => ({ getTracks: () => [track], getVideoTracks: () => [track], track });
const domError = (name) => Object.assign(new Error(name), { name });

async function load() {
  vi.resetModules();
  return import('../cameraScanner.js');
}

describe('cameraScanner', () => {
  const originalMediaDevices = navigator.mediaDevices;
  beforeEach(() => {
    detectorModule.createDetector.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: originalMediaDevices, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    vi.restoreAllMocks();
  });

  it('is supported only in a secure context with getUserMedia', async () => {
    const { cameraSupported } = await load();
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    expect(cameraSupported()).toBe(false);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(cameraSupported()).toBe(false);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    expect(cameraSupported()).toBe(true);
  });

  it('opens the rear camera into the video as a stream', async () => {
    const { openCamera } = await load();
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    const video = { play: vi.fn().mockResolvedValue() };
    expect(await openCamera(video)).toBe(stream);
    expect(video.srcObject).toBe(stream);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false, video: { facingMode: { ideal: 'environment' } } });
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no_camera'],
    ['OverconstrainedError', 'no_camera'],
    ['NotReadableError', 'busy'],
    ['TypeError', 'failed'],
  ])('explains %s as "%s"', async (name, reason) => {
    const { openCamera } = await load();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockRejectedValue(domError(name)) }, configurable: true });
    await expect(openCamera({ play: vi.fn() })).rejects.toMatchObject({ name: 'CameraError', reason });
  });

  it('releases the camera when the video cannot play', async () => {
    const { openCamera } = await load();
    const stream = fakeStream();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(stream) }, configurable: true });
    await expect(openCamera({ play: vi.fn().mockRejectedValue(new Error('no')) })).rejects.toMatchObject({ reason: 'failed' });
    expect(stream.track.stop).toHaveBeenCalled();
  });

  it('stops every track on close, and tolerates no stream', async () => {
    const { closeCamera } = await load();
    const stream = fakeStream();
    closeCamera(stream);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(() => closeCamera(null)).not.toThrow();
  });

  it('reports and switches the light only where the camera offers one', async () => {
    const { torchSupported, setTorch } = await load();
    const track = fakeTrack();
    expect(torchSupported(fakeStream(track))).toBe(false);
    track.getCapabilities.mockReturnValue({ torch: true });
    expect(torchSupported(fakeStream(track))).toBe(true);
    expect(await setTorch(fakeStream(track), true)).toBe(true);
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    track.applyConstraints.mockRejectedValue(new Error('no'));
    expect(await setTorch(fakeStream(track), false)).toBe(false);
  });

  it('loads the decoder once, and tries again after a failed load', async () => {
    const { loadDetector } = await load();
    detectorModule.createDetector.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ detect: vi.fn() });
    await expect(loadDetector()).rejects.toMatchObject({ reason: 'decoder' });
    const first = await loadDetector();
    expect(await loadDetector()).toBe(first);
    expect(detectorModule.createDetector).toHaveBeenCalledTimes(2);
  });

  describe('readFrame', () => {
    const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080 };

    it('skips a video that is not ready', async () => {
      const { readFrame } = await load();
      const detector = { detect: vi.fn() };
      expect(await readFrame(detector, { readyState: 1, videoWidth: 0 })).toBeNull();
      expect(detector.detect).not.toHaveBeenCalled();
    });

    it('decodes the frame from a canvas at most 1280 px wide', async () => {
      const { readFrame } = await load();
      const drawImage = vi.fn();
      vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage });
      const detector = { detect: vi.fn().mockResolvedValue([{ rawValue: '' }, { rawValue: '5449000000996', format: 'ean_13' }]) };
      expect(await readFrame(detector, video)).toBe('5449000000996');
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
      const canvas = detector.detect.mock.calls[0][0];
      expect(canvas).toBeInstanceOf(window.HTMLCanvasElement);
    });

    it('treats a failed or empty read as no barcode', async () => {
      const { readFrame } = await load();
      vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
      expect(await readFrame({ detect: vi.fn().mockResolvedValue([]) }, video)).toBeNull();
      expect(await readFrame({ detect: vi.fn().mockRejectedValue(new Error('bad frame')) }, video)).toBeNull();
    });
  });

  describe('diagnostics', () => {
    const video = { readyState: 4, videoWidth: 640, videoHeight: 480 };

    it('counts reads: started, finished, empty, errors, the last error, duration and frame size', async () => {
      const { readFrame, newScanStats } = await load();
      vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
      const stats = newScanStats();
      await readFrame({ detect: vi.fn().mockResolvedValue([]) }, video, stats);
      await readFrame({ detect: vi.fn().mockResolvedValue([{ rawValue: '111' }]) }, video, stats);
      await readFrame({ detect: vi.fn().mockRejectedValue(new Error('wasm trap')) }, video, stats);
      await readFrame({ detect: vi.fn() }, { readyState: 1 }, stats);
      expect(stats).toMatchObject({ attempts: 3, completed: 2, empty: 1, errors: 1, notReady: 1, lastCode: '111', lastError: 'wasm trap', frameSize: '640×480', inFlightSince: null });
      expect(typeof stats.lastMs).toBe('number');
    });

    it('describes the camera the stream really is', async () => {
      const { describeCamera } = await load();
      const track = {
        label: 'camera2 0, facing back',
        readyState: 'live',
        muted: false,
        getSettings: () => ({ facingMode: 'environment', width: 1280, height: 720, focusMode: 'continuous' }),
        getCapabilities: () => ({ focusMode: ['continuous', 'manual'], zoom: { min: 1, max: 8 }, torch: true, extra: 'x' }),
      };
      expect(describeCamera({ getVideoTracks: () => [track] })).toEqual({
        label: 'camera2 0, facing back',
        state: 'live',
        muted: false,
        settings: { facingMode: 'environment', width: 1280, height: 720, focusMode: 'continuous' },
        capabilities: { facingMode: undefined, focusMode: ['continuous', 'manual'], width: undefined, height: undefined, zoom: { min: 1, max: 8 }, torch: true },
      });
      expect(describeCamera(null)).toBeNull();
    });

    it('lists the cameras the device offers, and says so when it cannot', async () => {
      const { listCameras } = await load();
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput', label: 'back' }, { kind: 'audioinput', label: 'mic' }, { kind: 'videoinput', label: '' }]) },
        configurable: true,
      });
      expect(await listCameras()).toEqual(['back', '(no label)']);
      Object.defineProperty(navigator, 'mediaDevices', { value: { enumerateDevices: vi.fn().mockRejectedValue(new Error('nope')) }, configurable: true });
      expect((await listCameras())[0]).toContain('could not list');
    });

    it('records how the decoder load went', async () => {
      const { loadDetector, decoderInfo } = await load();
      expect(decoderInfo().state).toBe('idle');
      detectorModule.createDetector.mockRejectedValueOnce(new Error('CompileError: CSP')).mockResolvedValue({ detect: vi.fn() });
      await expect(loadDetector()).rejects.toBeTruthy();
      expect(decoderInfo()).toMatchObject({ state: 'failed', error: 'CompileError: CSP', wasmUrl: '/assets/zxing_reader-test.wasm' });
      await loadDetector();
      expect(decoderInfo()).toMatchObject({ state: 'ready', error: null });
    });
  });
});
