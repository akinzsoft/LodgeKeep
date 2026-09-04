import styles from './OfflineBanner.module.css';

/**
 * OfflineBanner — DESIGN_SYSTEM.md §2's sixth required state: "Offline /
 * degraded ... Show a persistent banner when the connection drops ... never
 * silently queue a payment as though it succeeded."
 *
 * Presentational, like every other shell piece — `AppShell` renders this
 * only while `isOffline` is true (typically fed by
 * `src/shared/hooks/useOnlineStatus.js`), and it disappears the instant
 * connectivity returns; there is no dismiss control, for the same reason
 * `ImpersonationBanner` has none — a hidden-but-still-true warning is worse
 * than a visible one.
 *
 * "Disable actions that would post financial transactions" is NOT this
 * component's job — it has no way to know which buttons on a real screen are
 * financial. What it does is make `isOffline` impossible to miss; each
 * feature module's own mutating actions are expected to check the same
 * signal (from `useOnlineStatus`) before allowing a financial submit, once
 * those modules exist (PLAN.md Phase 1+).
 */
export function OfflineBanner() {
  return (
    <div className={styles.banner} role="alert">
      <p className={styles.message}>
        You&rsquo;re offline. Financial actions are disabled until the connection returns.
      </p>
    </div>
  );
}
