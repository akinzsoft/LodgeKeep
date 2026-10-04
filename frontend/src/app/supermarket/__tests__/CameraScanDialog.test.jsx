import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { CameraScanDialog } from '../CameraScanDialog.jsx';

const scanner = vi.hoisted(() => ({
  openCamera: vi.fn(),
  closeCamera: vi.fn(),
  loadDetector: vi.fn(),
  readFrame: vi.fn(),
  torchSupported: vi.fn(),
  setTorch: vi.fn(),
}));
vi.mock('../../../shared/scanner/cameraScanner.js', () => scanner);
const sound = vi.hoisted(() => ({ playScanTone: vi.fn() }));
vi.mock('../../../shared/sound/alertBeep.js', () => sound);

const STREAM = { id: 'stream' };
const cameraError = (reason) => Object.assign(new Error(reason), { name: 'CameraError', reason });

/** Lets the read loop tick `n` times (125 ms each) and settle its promises. */
async function tick(n = 1) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });
  }
}

async function open(props = {}) {
  const onDetected = props.onDetected ?? vi.fn().mockResolvedValue({ kind: 'added', name: 'Coke 50cl', quantity: 1 });
  const onClose = props.onClose ?? vi.fn();
  const view = render(<CameraScanDialog onDetected={onDetected} onClose={onClose} cartCount={props.cartCount ?? 0} />);
  await act(async () => {}); // camera + decoder start
  return { ...view, onDetected, onClose };
}

describe('<CameraScanDialog>', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    Object.values(scanner).forEach((fn) => fn.mockReset());
    sound.playScanTone.mockReset();
    scanner.openCamera.mockResolvedValue(STREAM);
    scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
    scanner.readFrame.mockResolvedValue(null);
    scanner.torchSupported.mockReturnValue(false);
    navigator.vibrate = vi.fn();
    window.localStorage.removeItem('lodgekeep.scanSound');
  });
  afterEach(() => {
    vi.useRealTimers();
    delete navigator.vibrate;
  });

  it('starts the camera and the decoder, and invites a scan', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Scan products' })).toBeInTheDocument();
    expect(scanner.openCamera).toHaveBeenCalledWith(expect.any(window.HTMLVideoElement));
    expect(screen.getByText('Point the camera at a barcode.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('adds a read through onDetected with a beep, a vibration and the product name', async () => {
    scanner.readFrame.mockResolvedValueOnce('5449000000996');
    const { onDetected } = await open({ onDetected: vi.fn().mockResolvedValue({ kind: 'added', name: 'Coke 50cl', quantity: 2 }), cartCount: 3 });
    await tick();
    expect(onDetected).toHaveBeenCalledWith('5449000000996');
    expect(screen.getByText('Added Coke 50cl ×2')).toBeInTheDocument();
    expect(sound.playScanTone).toHaveBeenCalledWith('ok');
    expect(navigator.vibrate).toHaveBeenCalledWith(40);
    expect(screen.getByText('3 items in the sale')).toBeInTheDocument();
  });

  it('ignores the same barcode for 1.5 s, then accepts it again', async () => {
    scanner.readFrame.mockResolvedValue('111');
    const { onDetected } = await open();
    await tick(); // first read
    await tick(8); // 1 s of the same code in view
    expect(onDetected).toHaveBeenCalledTimes(1);
    await tick(5); // past 1.5 s
    expect(onDetected).toHaveBeenCalledTimes(2);
  });

  it('accepts a different barcode at once', async () => {
    scanner.readFrame.mockResolvedValueOnce('111').mockResolvedValueOnce('222');
    const { onDetected } = await open();
    await tick(2);
    expect(onDetected.mock.calls.map((call) => call[0])).toEqual(['111', '222']);
  });

  it('never runs two reads at once', async () => {
    let answer;
    scanner.readFrame.mockResolvedValueOnce('111').mockResolvedValue('222');
    const onDetected = vi.fn().mockReturnValueOnce(new Promise((resolve) => (answer = resolve))).mockResolvedValue({ kind: 'added', name: 'B', quantity: 1 });
    await open({ onDetected });
    await tick(6);
    expect(onDetected).toHaveBeenCalledTimes(1);
    await act(async () => answer({ kind: 'added', name: 'A', quantity: 1 }));
    await tick();
    expect(onDetected).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: 'not_found' }, 'No product has barcode 999'],
    [{ kind: 'sold_out', name: 'Peak Milk' }, 'Peak Milk is sold out'],
    [{ kind: 'error', message: 'Could not reach the server.' }, 'Could not reach the server.'],
  ])('reports %j with the error tone and stays open', async (outcome, text) => {
    scanner.readFrame.mockResolvedValueOnce('999');
    const { onClose } = await open({ onDetected: vi.fn().mockResolvedValue(outcome) });
    await tick();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(sound.playScanTone).toHaveBeenCalledWith('error');
    expect(navigator.vibrate).toHaveBeenCalledWith([80, 60, 80]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('remembers a mute on the device and then plays no tone', async () => {
    scanner.readFrame.mockResolvedValueOnce(null).mockResolvedValueOnce('111');
    await open();
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('lodgekeep.scanSound')).toBe('off');
    await tick(2);
    expect(screen.getByText(/Added Coke/)).toBeInTheDocument();
    expect(sound.playScanTone).not.toHaveBeenCalled();
  });

  it('starts muted when the device remembers it', async () => {
    window.localStorage.setItem('lodgekeep.scanSound', 'off');
    await open();
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('explains a refused camera, with no retry (the user must allow it first)', async () => {
    scanner.openCamera.mockRejectedValue(cameraError('denied'));
    await open();
    expect(screen.getByRole('alert')).toHaveTextContent('Camera access is blocked for this site');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(scanner.closeCamera).toHaveBeenCalled();
  });

  it.each([
    ['no_camera', 'No camera was found on this device', false],
    ['busy', 'being used by another app', true],
    ['decoder', 'barcode reader could not load', true],
  ])('explains %s', async (reason, text, retry) => {
    scanner.openCamera.mockRejectedValueOnce(cameraError(reason));
    await open();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry);
    if (retry) {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
      expect(scanner.openCamera).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Point the camera at a barcode.')).toBeInTheDocument();
    }
  });

  it('closes on Done and on Escape, and releases the camera when it goes away', async () => {
    const { onClose, unmount } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    scanner.closeCamera.mockClear();
    unmount();
    expect(scanner.closeCamera).toHaveBeenCalledWith(STREAM);
  });

  it('releases the camera while the page is hidden and restarts it when it returns', async () => {
    await open();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(scanner.closeCamera).toHaveBeenCalledWith(STREAM);
    expect(screen.getByText('Camera paused.')).toBeInTheDocument();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(scanner.openCamera).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Point the camera at a barcode.')).toBeInTheDocument();
  });

  it('offers the light only when the camera has one', async () => {
    scanner.torchSupported.mockReturnValue(true);
    scanner.setTorch.mockResolvedValue(true);
    await open();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Light' })));
    expect(scanner.setTorch).toHaveBeenCalledWith(STREAM, true);
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  });

  describe('never leaves the camera on', () => {
    it('releases the camera when the decoder fails after the camera opened', async () => {
      scanner.loadDetector.mockRejectedValue(cameraError('decoder'));
      await open();
      expect(scanner.closeCamera).toHaveBeenCalledWith(STREAM);
      expect(screen.getByRole('alert')).toHaveTextContent('barcode reader could not load');
    });

    it('releases a camera that finishes opening after the view closed', async () => {
      let resolveCamera;
      scanner.openCamera.mockReturnValue(new Promise((resolve) => (resolveCamera = resolve)));
      const { unmount } = render(<CameraScanDialog onDetected={vi.fn()} onClose={vi.fn()} />);
      unmount(); // Done tapped while the permission prompt was showing
      const late = { id: 'late' };
      await act(async () => resolveCamera(late));
      expect(scanner.closeCamera).toHaveBeenCalledWith(late);
    });

    it('releases a camera that finishes opening after the page was hidden, and starts again when it returns', async () => {
      let resolveCamera;
      scanner.openCamera.mockReturnValueOnce(new Promise((resolve) => (resolveCamera = resolve)));
      render(<CameraScanDialog onDetected={vi.fn()} onClose={vi.fn()} />);
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      const late = { id: 'late' };
      await act(async () => resolveCamera(late));
      expect(scanner.closeCamera).toHaveBeenCalledWith(late);
      expect(screen.getByText('Camera paused.')).toBeInTheDocument();
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(screen.getByText('Point the camera at a barcode.')).toBeInTheDocument();
    });

    it('a second start never leaves the first camera running', async () => {
      scanner.openCamera.mockRejectedValueOnce(cameraError('busy'));
      await open();
      const retry = screen.getByRole('button', { name: 'Try again' });
      await act(async () => {
        fireEvent.click(retry);
        fireEvent.click(retry);
      });
      // Each start releases whatever the previous one held before opening another.
      const opened = scanner.openCamera.mock.results.length;
      expect(opened).toBe(3);
      expect(scanner.closeCamera.mock.calls.filter(([stream]) => stream === STREAM).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('modal focus', () => {
    it('keeps Tab inside the view', async () => {
      await open();
      const done = screen.getByRole('button', { name: 'Done' });
      const mute = screen.getByRole('button', { name: 'Mute' });
      done.focus();
      fireEvent.keyDown(done, { key: 'Tab' });
      expect(mute).toHaveFocus();
      fireEvent.keyDown(mute, { key: 'Tab', shiftKey: true });
      expect(done).toHaveFocus();
    });

    it('returns focus to where it came from when the view goes away for any reason', async () => {
      const opener = document.createElement('button');
      opener.textContent = 'Scan';
      document.body.appendChild(opener);
      opener.focus();
      const { unmount } = await open();
      expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
      unmount(); // e.g. the device went offline
      expect(opener).toHaveFocus();
      opener.remove();
    });
  });
});
