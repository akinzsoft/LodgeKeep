import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const detectorModule = vi.hoisted(() => ({ createDetector: vi.fn(), WASM_URL: '/assets/zxing_reader-test.wasm' }));
vi.mock('../detector.js', () => detectorModule);

const fakeTrack = (settings = {}) => ({ stop: vi.fn(), getCapabilities: vi.fn(() => ({})), getSettings: vi.fn(() => settings), applyConstraints: vi.fn().mockResolvedValue() });
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
    window.localStorage.removeItem('lodgekeep.scanCamera.v2');
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
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) }, configurable: true });
    const video = { play: vi.fn().mockResolvedValue() };
    expect(await openCamera(video)).toBe(stream);
    expect(video.srcObject).toBe(stream);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
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
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(stream), enumerateDevices: vi.fn().mockResolvedValue([]) }, configurable: true });
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

    it('decodes the centre band at full detail, and every third read the whole frame, never wider than 1600 px', async () => {
      const { readFrame } = await load();
      const drawImage = vi.fn();
      vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage });
      const detector = { detect: vi.fn().mockResolvedValue([{ rawValue: '' }, { rawValue: '5449000000996', format: 'ean_13' }]) };
      expect(await readFrame(detector, video)).toBe('5449000000996');
      // 1920×1080: the centre 90% wide band, 1728×1037 from (96, 22), scaled to 1600×960.
      expect(drawImage).toHaveBeenLastCalledWith(video, 96, 22, 1728, 1037, 0, 0, 1600, 960);
      await readFrame(detector, video);
      await readFrame(detector, video);
      expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 1920, 1080, 0, 0, 1600, 900);
      expect(detector.detect.mock.calls[0][0]).toBeInstanceOf(window.HTMLCanvasElement);
    });

    it('abandons a read that never answers after 3 s, counting it as an error, and keeps counting until a read succeeds', async () => {
      vi.useFakeTimers();
      try {
        const { readFrame, newScanStats } = await load();
        vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
        const stats = newScanStats();
        const hung = readFrame({ detect: () => new Promise(() => {}) }, video, stats);
        await vi.advanceTimersByTimeAsync(3000);
        expect(await hung).toBeNull();
        expect(stats).toMatchObject({ errors: 1, consecutiveErrors: 1, lastError: 'Decoding took longer than 3 s' });
        await readFrame({ detect: vi.fn().mockRejectedValue(new Error('trap')) }, video, stats);
        expect(stats.consecutiveErrors).toBe(2);
        await readFrame({ detect: vi.fn().mockResolvedValue([]) }, video, stats);
        expect(stats.consecutiveErrors).toBe(0);
      } finally {
        vi.useRealTimers();
      }
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

  describe('choosing the camera', () => {
    const device = (label, deviceId) => ({ kind: 'videoinput', label, deviceId });

    it('picks the main rear lens, never the ultra-wide or telephoto, and none when no camera is recognisably rear', async () => {
      const { chooseMainRearCamera } = await load();
      // Android Chrome labels; the ultra-wide is camera2 2 and says nothing about being wide.
      expect(chooseMainRearCamera([device('camera2 1, facing front', 'f'), device('camera2 2, facing back', 'uw'), device('camera2 0, facing back', 'main')]).deviceId).toBe('main');
      // iPhone labels.
      expect(chooseMainRearCamera([device('Back Ultra Wide Camera', 'uw'), device('Back Dual Wide Camera', 'dw'), device('Back Telephoto Camera', 't')]).deviceId).toBe('dw');
      expect(chooseMainRearCamera([device('Back Ultra Wide Camera', 'uw'), device('Back Camera', 'main')]).deviceId).toBe('main');
      // Other Android builds name the lenses: the ultra-wide is listed first and must still lose.
      expect(chooseMainRearCamera([device('Rear ultra wide camera', 'uw'), device('Rear camera', 'main')]).deviceId).toBe('main');
      expect(chooseMainRearCamera([device('Front Camera', 'f'), { kind: 'audioinput', label: 'Back mic', deviceId: 'm' }])).toBeNull();
    });

    function phone({ current, devices, focus = {}, failExact = false, failExactWith = 'OverconstrainedError', failFallbackAfterSwitch = false }) {
      const streams = [];
      let opens = 0;
      const getUserMedia = vi.fn(async (constraints) => {
        opens += 1;
        const exact = constraints.video.deviceId?.exact;
        if (exact && failExact) throw domError(failExactWith);
        if (!exact && failFallbackAfterSwitch && opens > 2) throw domError('NotReadableError');
        const deviceId = exact ?? current;
        const track = fakeTrack({ deviceId });
        if (focus[deviceId]) track.getCapabilities.mockReturnValue({ focusMode: focus[deviceId] });
        const stream = fakeStream(track);
        streams.push(stream);
        return stream;
      });
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue(devices) }, configurable: true });
      return { getUserMedia, streams };
    }
    const lenses = [device('camera2 2, facing back', 'uw'), device('camera2 0, facing back', 'main')];
    const video = () => ({ play: vi.fn().mockResolvedValue() });

    it('switches from the ultra-wide to the main lens, releasing the first, and remembers it', async () => {
      const { openCamera } = await load();
      const { getUserMedia, streams } = phone({ current: 'uw', devices: lenses });
      const stream = await openCamera(video());
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(getUserMedia.mock.calls[1][0].video).toMatchObject({ deviceId: { exact: 'main' } });
      expect(streams[0].track.stop).toHaveBeenCalled();
      expect(stream).toBe(streams[1]);
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('main');
    });

    it('stays on the camera it got when that is already the main lens', async () => {
      const { openCamera } = await load();
      const { getUserMedia } = phone({ current: 'main', devices: lenses });
      await openCamera(video());
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('main');
    });

    it('opens the remembered camera directly next time, and chooses again if it is gone', async () => {
      const { openCamera } = await load();
      window.localStorage.setItem('lodgekeep.scanCamera.v2', 'main');
      const first = phone({ current: 'main', devices: lenses });
      await openCamera(video());
      expect(first.getUserMedia).toHaveBeenCalledTimes(1);
      expect(first.getUserMedia.mock.calls[0][0].video).toMatchObject({ deviceId: { exact: 'main' } });

      window.localStorage.setItem('lodgekeep.scanCamera.v2', 'gone');
      const second = phone({ current: 'main', devices: lenses, failExact: true });
      await openCamera(video());
      expect(second.getUserMedia.mock.calls[1][0].video).toMatchObject({ facingMode: { ideal: 'environment' } });
    });

    it('falls back to the browser\u2019s camera if the main lens will not open, without remembering that fallback', async () => {
      const { openCamera } = await load();
      const { getUserMedia } = phone({ current: 'uw', devices: lenses, failExact: true });
      const stream = await openCamera(video());
      // facingMode (gave uw), the main lens (refused), uw by id (refused), then facingMode again.
      expect(getUserMedia).toHaveBeenCalledTimes(4);
      expect(stream.track.getSettings().deviceId).toBe('uw');
      expect(stream.track.stop).not.toHaveBeenCalled(); // a live stream, never a stopped one
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBeNull();
    });

    it('reports an error, never a stopped stream, when neither the main lens nor the fallback opens', async () => {
      const { openCamera } = await load();
      phone({ current: 'uw', devices: lenses, failExact: true, failExactWith: 'NotReadableError', failFallbackAfterSwitch: true });
      await expect(openCamera(video())).rejects.toMatchObject({ name: 'CameraError', reason: 'busy' });
    });

    it('keeps the remembered lens when the camera is only busy', async () => {
      const { openCamera } = await load();
      window.localStorage.setItem('lodgekeep.scanCamera.v2', 'main');
      phone({ current: 'main', devices: lenses, failExact: true, failExactWith: 'NotReadableError' });
      await expect(openCamera(video())).rejects.toMatchObject({ reason: 'busy' });
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('main');
    });

    it('turns on continuous autofocus where the camera offers it, and leaves it alone otherwise', async () => {
      const { openCamera } = await load();
      const withFocus = fakeTrack({ deviceId: 'main' });
      withFocus.getCapabilities.mockReturnValue({ focusMode: ['manual', 'continuous'] });
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream(withFocus)), enumerateDevices: vi.fn().mockResolvedValue([]) }, configurable: true });
      await openCamera(video());
      expect(withFocus.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] });

      const fixed = fakeTrack({ deviceId: 'main' });
      fixed.getCapabilities.mockReturnValue({ focusMode: ['manual'] });
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream(fixed)), enumerateDevices: vi.fn().mockResolvedValue([]) }, configurable: true });
      await openCamera(video());
      expect(fixed.applyConstraints).not.toHaveBeenCalled();
    });

    // The real phone (2026-10-04 screenshot): two back cameras labelled with a space,
    // Chrome handed over "camera 2" which offers manual focus only.
    const realPhone = [
      device('camera 1, facing front', 'f1'),
      device('camera 3, facing front', 'f3'),
      device('camera 2, facing back', 'c2'),
      device('camera 0, facing back', 'c0'),
    ];

    it('ranks the main lens first whichever way Android labels it, then by lowest camera id', async () => {
      const { rankRearCameras, chooseMainRearCamera } = await load();
      expect(chooseMainRearCamera(realPhone).deviceId).toBe('c0');
      expect(chooseMainRearCamera([device('camera2 2, facing back', 'c2'), device('camera2 0, facing back', 'c0')]).deviceId).toBe('c0');
      // No main-lens label at all: the lowest Android id wins over list order.
      expect(rankRearCameras([device('camera 4, facing back', 'c4'), device('camera 2, facing back', 'c2')]).map((d) => d.deviceId)).toEqual(['c2', 'c4']);
      // "camera 2" must not be read as camera 0.
      expect(rankRearCameras([device('camera 2, facing back', 'c2')]).map((d) => d.deviceId)).toEqual(['c2']);
    });

    it('on the real phone, leaves the fixed-focus camera 2 for camera 0 and remembers it', async () => {
      const { openCamera } = await load();
      const { getUserMedia, streams } = phone({ current: 'c2', devices: realPhone, focus: { c2: ['manual'], c0: ['manual', 'continuous'] } });
      const stream = await openCamera(video());
      expect(stream.track.getSettings().deviceId).toBe('c0');
      expect(streams[0].track.stop).toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('c0');
    });

    it('skips a lens that reports no autofocus for the next one that has it, even against the label ranking', async () => {
      const { openCamera } = await load();
      const { getUserMedia } = phone({ current: 'c0', devices: realPhone, focus: { c0: ['manual'], c2: ['continuous'] } });
      const stream = await openCamera(video());
      expect(stream.track.getSettings().deviceId).toBe('c2');
      expect(getUserMedia.mock.calls[1][0].video).toMatchObject({ deviceId: { exact: 'c2' } });
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('c2');
    });

    it('when no lens reports autofocus, goes back to the best-ranked one and remembers it', async () => {
      const { openCamera } = await load();
      const { getUserMedia } = phone({ current: 'c2', devices: realPhone, focus: { c2: ['manual'], c0: ['manual'] } });
      const stream = await openCamera(video());
      expect(stream.track.getSettings().deviceId).toBe('c0');
      expect(stream.track.stop).not.toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenCalledTimes(4); // c2 (browser), c0, c2, back to c0
      expect(window.localStorage.getItem('lodgekeep.scanCamera.v2')).toBe('c0');
    });

    it('trusts the ranking without probing when the browser does not report focus modes', async () => {
      const { openCamera } = await load();
      const { getUserMedia } = phone({ current: 'c2', devices: realPhone });
      await openCamera(video());
      expect(getUserMedia).toHaveBeenCalledTimes(2); // c2, then c0 — never back to c2
    });

    it('forgets a lens remembered under the old key, so a phone stuck on the wrong lens chooses again', async () => {
      const { openCamera } = await load();
      window.localStorage.setItem('lodgekeep.scanCamera', 'c2');
      const { getUserMedia } = phone({ current: 'c2', devices: realPhone, focus: { c2: ['manual'], c0: ['continuous'] } });
      const stream = await openCamera(video());
      expect(getUserMedia.mock.calls[0][0].video).toMatchObject({ facingMode: { ideal: 'environment' } });
      expect(stream.track.getSettings().deviceId).toBe('c0');
      expect(window.localStorage.getItem('lodgekeep.scanCamera')).toBeNull();
    });
  });
});
