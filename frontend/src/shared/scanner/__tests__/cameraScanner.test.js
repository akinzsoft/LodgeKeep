import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const detectorModule = vi.hoisted(() => ({ createDetector: vi.fn() }));
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
});
