import { useEffect, useRef, useState } from 'react';
import { describeCamera, decoderInfo, listCameras, lastFrame } from '../../shared/scanner/cameraScanner.js';
import styles from './CameraScan.module.css';

const REFRESH_MS = 300;
const STUCK_MS = 2000;

/**
 * On-screen scanner diagnostics, shown only when the till is opened with
 * `?scandebug=1` (no effect on scanning): which camera opened and what it
 * delivers, whether the decoder loaded, how reads are going (started,
 * finished, empty, errors, a read stuck for over 2 s), and a small copy of
 * the exact frame the decoder last received, to see blur or the wrong lens.
 */
export function ScanDebugPanel({ stream, video, stats }) {
  const [snapshot, setSnapshot] = useState(null);
  const [cameras, setCameras] = useState([]);
  const preview = useRef(null);

  useEffect(() => {
    let cancelled = false;
    listCameras().then((list) => {
      if (!cancelled) setCameras(list);
    });
    const timer = setInterval(() => {
      const v = video.current;
      const s = stats.current;
      setSnapshot({
        camera: describeCamera(stream.current),
        decoder: decoderInfo(),
        video: v ? { readyState: v.readyState, size: `${v.videoWidth}×${v.videoHeight}`, paused: v.paused } : null,
        stats: { ...s, stuck: s.inFlightSince ? Date.now() - s.inFlightSince > STUCK_MS : false },
      });
      const frame = lastFrame();
      const target = preview.current;
      if (frame && target && frame.width) {
        target.width = 160;
        target.height = Math.round((160 * frame.height) / frame.width);
        target.getContext('2d')?.drawImage(frame, 0, 0, target.width, target.height);
      }
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stream, video, stats]);

  if (!snapshot) return null;
  const { camera, decoder, video: v, stats: s } = snapshot;
  const settings = camera?.settings ?? {};
  const lines = [
    `camera: ${camera?.label || '(none)'}  state=${camera?.state ?? '-'}${camera?.muted ? ' MUTED' : ''}`,
    `facing=${settings.facingMode ?? '?'}  ${settings.width ?? '?'}×${settings.height ?? '?'} @ ${settings.frameRate ? Math.round(settings.frameRate) : '?'}fps  focus=${settings.focusMode ?? '?'}  zoom=${settings.zoom ?? '-'}`,
    `supports: focus=${JSON.stringify(camera?.capabilities?.focusMode ?? null)} zoom=${JSON.stringify(camera?.capabilities?.zoom ?? null)} torch=${String(camera?.capabilities?.torch ?? false)}`,
    `cameras (${cameras.length}): ${cameras.join(' | ')}`,
    `video: readyState=${v?.readyState ?? '-'} size=${v?.size ?? '-'}${v?.paused ? ' PAUSED' : ''}`,
    `decoder: ${decoder.state}${decoder.loadMs != null ? ` in ${decoder.loadMs}ms` : ''}  wasm=${decoder.wasmUrl ?? '-'}${decoder.error ? `  ERROR ${decoder.error}` : ''}`,
    `reads: started=${s.attempts} finished=${s.completed} empty=${s.empty} errors=${s.errors} notReady=${s.notReady}${s.stuck ? '  STUCK' : ''}`,
    `last read: ${s.lastMs ?? '-'}ms frame=${s.frameSize ?? '-'} code=${s.lastCode ?? '-'}`,
    s.lastError ? `last error: ${s.lastError}` : null,
  ].filter(Boolean);

  return (
    <div className={styles.debugPanel} aria-label="Scanner diagnostics">
      <pre className={styles.debugText}>{lines.join('\n')}</pre>
      <canvas ref={preview} className={styles.debugPreview} aria-label="Last frame sent to the decoder" />
    </div>
  );
}
