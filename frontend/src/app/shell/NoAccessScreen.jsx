import { Button } from '../../shared/components/index.js';
import styles from './NoAccessScreen.module.css';

/**
 * Shown in place of a screen the signed-in user's role cannot open at the
 * active property — e.g. after switching to a property where they hold a
 * narrower role, or an item whose permission was revoked.
 *
 * Before this existed, `main.jsx` silently swapped in the Home dashboard
 * for any screen the user was not allowed to see, so a user with no access
 * saw the nav item highlighted and the wrong page with no explanation.
 * DESIGN_SYSTEM.md §2: a failure gets an explicit message, never a silent
 * redirect. The API check against SECURITY.md §5's matrix is still the real
 * enforcement; this is only the honest UI for it.
 */
export function NoAccessScreen({ onGoHome }) {
  return (
    <div className={styles.page} role="alert">
      <h1 className={styles.title}>You don&apos;t have access to this</h1>
      <p className={styles.body}>
        Your role at this property doesn&apos;t include this screen. If you think that&apos;s a mistake, ask an
        administrator to check your access.
      </p>
      <Button variant="secondary" onClick={onGoHome}>
        Go to Home
      </Button>
    </div>
  );
}
