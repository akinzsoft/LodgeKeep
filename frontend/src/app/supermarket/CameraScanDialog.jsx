import { useCallback, useEffect, useRef, useState } from 'react';
import { openCamera, closeCamera, loadDetector, readFrame, torchSupported, setTorch, newScanStats } from '../../shared/scanner/cameraScanner.js';
import { ScanDebugPanel } from './ScanDebugPanel.jsx';
import { playScanTone } from '../../shared/sound/alertBeep.js';
import styles from './CameraScan.module.css';

const FRAME_INTERVAL_MS = 125; // about 8 reads a second
const SAME_CODE_COOLDOWN_MS = 1500; // a box held in front of the camera is added once
const SOUND_KEY = 'lodgekeep.scanSound';

const MESSAGES = {
  denied: 'Camera access is blocked for this site. Allow the camera in your browser’s site settings (on an iPhone: Settings → Safari → Camera), then tap Scan again. You can still type the barcode.',
  no_camera: 'No camera was found on this device. Type the barcode instead.',
  busy: 'The camera is being used by another app. Close that app, then try again.',
  decoder: 'The barcode reader could not load. Check the connection, then try again.',
  failed: 'The camera could not start. Try again, or type the barcode.',
};
const RETRYABLE = new Set(['busy', 'decoder', 'failed']);
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function readSoundOn() {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}
function saveSoundOn(on) {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}

/** What one answer from `onDetected` means for the cashier. */
function describeOutcome(outcome, code) {
  switch (outcome?.kind) {
    case 'added':
      return { ok: true, text: `Added ${outcome.name}${outcome.quantity > 1 ? ` ×${outcome.quantity}` : ''}` };
    case 'sold_out':
      return { ok: false, text: `${outcome.name} is sold out` };
    case 'not_found':
      return { ok: false, text: `No product has barcode ${code}` };
    default:
      return { ok: false, text: outcome?.message ?? 'Could not look that up.' };
  }
}

/**
 * CameraScanDialog — the supermarket till's full-screen camera scanner,
 * continuous: it stays open while the cashier scans the basket. Each new
 * barcode goes to `onDetected(code)` (the till's own lookup-and-add, shared
 * with the typed box), and the answer is shown, beeped (unless muted on this
 * device) and vibrated where the phone allows it. The same code is ignored for
 * 1.5 s; reads never overlap.
 *
 * The camera must never be left on: every start carries a token, and a start
 * that finishes after the view closed, the page was hidden or another start
 * began releases what it opened. It is modal: focus stays inside, and goes
 * back to where it came from when the view goes away for any reason.
 */
export function CameraScanDialog({ onDetected, onClose, cartCount = 0, debug = false }) {
  const overlay = useRef(null);
  const video = useRef(null);
  const stream = useRef(null);
  const detector = useRef(null);
  const run = useRef(0); // the current start's token; anything older is stale
  const last = useRef({ code: null, at: 0 });
  const doneButton = useRef(null);
  const stats = useRef(newScanStats()); // read counters, shown only by the ?scandebug=1 panel

  const [status, setStatus] = useState('starting'); // starting | scanning | paused | error
  const [errorReason, setErrorReason] = useState(null);
  const [result, setResult] = useState(null); // {ok, text, id}
  const [soundOn, setSoundOn] = useState(readSoundOn);
  const [torch, setTorchState] = useState({ supported: false, on: false });
  // Read by the visibility handler and the read loop, outside render.
  const statusRef = useRef(status);
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  /** Releases the camera and makes any start still in flight stale. */
  const stop = useCallback(() => {
    run.current += 1;
    closeCamera(stream.current);
    stream.current = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    const token = run.current;
    setStatus('starting');
    setErrorReason(null);
    const decoder = loadDetector(); // downloads while the camera (and its permission prompt) opens
    decoder.catch(() => {}); // handled below; never an unhandled rejection
    let opened = null;
    try {
      opened = await openCamera(video.current);
      if (token !== run.current) {
        closeCamera(opened);
        return;
      }
      stream.current = opened; // recorded at once, so stop() always releases it
      const loaded = await decoder;
      if (token !== run.current) return; // stop() already released the camera
      detector.current = loaded;
      setTorchState({ supported: torchSupported(opened), on: false });
      setStatus('scanning');
    } catch (error) {
      if (token !== run.current) {
        closeCamera(opened);
        return;
      }
      stop();
      setErrorReason(error?.reason ?? 'failed');
      setStatus('error');
    }
  }, [stop]);

  useEffect(() => {
    const opener = document.activeElement;
    const node = overlay.current;
    doneButton.current?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the camera is this component's mount effect
    start();
    return () => {
      stop();
      // Closed for any reason (Done, Escape, offline, another tab): focus goes back unless the caller moved it.
      const active = document.activeElement;
      if ((!active || active === document.body || node?.contains(active)) && opener?.isConnected) opener.focus();
    };
  }, [start, stop]);

  // Release the camera while the page is hidden; bring it back when it returns.
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) {
        if (statusRef.current !== 'scanning' && statusRef.current !== 'starting') return;
        stop();
        setStatus('paused');
      } else if (statusRef.current === 'paused') {
        start();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [start, stop]);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(overlay.current?.querySelectorAll(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const lastItem = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      first.focus();
    }
  }

  const feedback = useCallback(({ ok, text }) => {
    if (soundOnRef.current) playScanTone(ok ? 'ok' : 'error');
    try {
      navigator.vibrate?.(ok ? 40 : [80, 60, 80]);
    } catch {
      // Not every browser allows vibration (iOS never does).
    }
    setResult({ ok, text, id: Date.now() });
  }, []);

  // The read loop: one read at a time, then a short pause.
  useEffect(() => {
    if (status !== 'scanning') return undefined;
    let cancelled = false;
    let timer = null;
    async function loop() {
      if (cancelled) return;
      const code = await readFrame(detector.current, video.current, stats.current);
      const now = Date.now();
      if (code && !cancelled && !(code === last.current.code && now - last.current.at < SAME_CODE_COOLDOWN_MS)) {
        last.current = { code, at: now };
        const outcome = await onDetected(code);
        last.current = { code, at: Date.now() }; // the cooldown runs from the answer, not the read
        if (!cancelled) feedback(describeOutcome(outcome, code));
      }
      if (!cancelled) timer = setTimeout(loop, FRAME_INTERVAL_MS);
    }
    timer = setTimeout(loop, FRAME_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, onDetected, feedback]);

  function toggleSound() {
    const next = !soundOn;
    saveSoundOn(next);
    setSoundOn(next);
  }

  async function toggleTorch() {
    const next = !torch.on;
    if (await setTorch(stream.current, next)) setTorchState((current) => ({ ...current, on: next }));
  }

  const statusText =
    status === 'starting'
      ? 'Starting the camera…'
      : status === 'paused'
        ? 'Camera paused.'
        : status === 'scanning'
          ? result?.text ?? 'Point the camera at a barcode.'
          : '';

  return (
    <div ref={overlay} className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="camera-scan-title" onKeyDown={onKeyDown}>
      <div className={styles.viewport}>
        <video ref={video} className={styles.video} playsInline muted autoPlay aria-hidden="true" />
        {status === 'scanning' && (
          <div key={result?.id ?? 'aim'} className={`${styles.aim} ${result ? (result.ok ? styles.aimOk : styles.aimError) : ''}`} aria-hidden="true" />
        )}
        {debug && <ScanDebugPanel stream={stream} video={video} stats={stats} />}
        <div className={styles.topBar}>
          <h2 id="camera-scan-title" className={styles.title}>Scan products</h2>
          <div className={styles.topActions}>
            {torch.supported && (
              <button type="button" className={styles.toggle} aria-pressed={torch.on} onClick={toggleTorch}>Light</button>
            )}
            <button type="button" className={styles.toggle} aria-pressed={!soundOn} onClick={toggleSound}>Mute</button>
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        {/* One live region, its text changed in place, so every answer is announced. */}
        <p
          className={`${styles.status} ${status === 'scanning' && result ? (result.ok ? styles.resultOk : styles.resultError) : ''}`}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </p>
        {status === 'error' && (
          <div className={styles.error} role="alert">
            <p>{MESSAGES[errorReason] ?? MESSAGES.failed}</p>
            {RETRYABLE.has(errorReason) && (
              <button type="button" className={styles.toggle} onClick={start}>Try again</button>
            )}
          </div>
        )}
        <div className={styles.panelFooter}>
          <span className={styles.cartCount}>{cartCount === 1 ? '1 item in the sale' : `${cartCount} items in the sale`}</span>
          <button ref={doneButton} type="button" className={styles.doneButton} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
