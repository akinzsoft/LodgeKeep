import { useEffect } from 'react';
import styles from './Toast.module.css';

/**
 * Toast — DESIGN_SYSTEM.md §2's success feedback, specifically: "toast,
 * top-right, --state-success-bg background with --state-success text and a
 * check icon, auto-dismiss after ~4s. Wording is past tense and plain ...
 * Never 'successfully' — the toast is the success."
 *
 * §2 also draws a hard line this component enforces rather than just
 * documents: "Destructive-adjacent successes (void, refund, cancellation)
 * show a persistent inline confirmation instead of a disappearing toast" and
 * error/warning messages belong in a banner or inline field error, never a
 * toast ("Toasts are for transient confirmation only"). A caller reaching for
 * `tone="danger"` almost always wants a banner instead — this component
 * still renders it (a hard block would be one more thing blocking a screen
 * that has a genuine edge case), but warns loudly in development, the
 * strongest tool a component library has for a UX policy no type system can
 * express.
 *
 * @param {string} message              Past tense, plain — "Check-in complete", never "successfully X".
 * @param {'success'|'info'} [tone]
 * @param {() => void} [onDismiss]       Called on auto-dismiss and on manual close.
 * @param {number} [duration]            Defaults to the --toast-duration token (~4s).
 */
export function Toast({ message, tone = 'success', onDismiss, duration }) {
  if (import.meta.env?.DEV && (tone === 'danger' || tone === 'warning')) {
    console.warn(
      `Toast: tone="${tone}" was requested. DESIGN_SYSTEM.md §2 reserves toasts for transient ` +
        'success confirmation — an error belongs in a banner, a destructive-adjacent success ' +
        '(void/refund/cancellation) in a persistent inline confirmation. Reconsider before shipping this.'
    );
  }

  useEffect(() => {
    if (!onDismiss) return undefined;
    const ms = duration ?? 4000;
    const timer = setTimeout(onDismiss, ms);
    return () => clearTimeout(timer);
  }, [onDismiss, duration]);

  return (
    <div className={`${styles.toast} ${styles[tone]}`} role="status" aria-live="polite">
      <span className={styles.icon} aria-hidden="true">
        ✓
      </span>
      <p className={styles.message}>{message}</p>
      {onDismiss && (
        <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
