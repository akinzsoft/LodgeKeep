import styles from './ImpersonationBanner.module.css';

/**
 * ImpersonationBanner — PRODUCT_REQUIREMENTS.md's App shell, Top bar: "When a
 * Planmsys staff member is impersonating a tenant (SECURITY.md §2), a
 * persistent, visually distinct banner states whose account is being viewed
 * and offers an exit action. This must be impossible to miss or dismiss."
 *
 * Deliberately has no close/dismiss control of any kind — only `onExit`,
 * which ends the audited impersonation grant itself (SECURITY.md §2), not
 * the banner's visibility. A dismiss button would be exactly the "silent
 * super-admin" ergonomic SECURITY.md §2 rules out: a support engineer
 * could hide the warning and keep working inside a tenant's account as if
 * it were invisible.
 *
 * @param {string} tenantName
 * @param {() => void} onExit
 */
export function ImpersonationBanner({ tenantName, onExit }) {
  return (
    <div className={styles.banner} role="alert">
      <p className={styles.message}>
        Viewing <strong>{tenantName}</strong>&rsquo;s account as Planmsys staff.
      </p>
      <button type="button" className={styles.exit} onClick={onExit}>
        Exit impersonation
      </button>
    </div>
  );
}
