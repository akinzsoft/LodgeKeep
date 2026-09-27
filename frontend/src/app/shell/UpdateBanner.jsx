import { Button } from '../../shared/components/index.js';
import styles from './UpdateBanner.module.css';

/**
 * A new version of the app has been deployed while this page was open
 * (`useNewVersionAvailable`). The page keeps working on the old version until
 * someone reloads — a reload is never forced, because the Register may hold a
 * half-rung tab or a form may be half filled in. "Later" hides it for the
 * rest of this page's life; the next time the page is loaded it runs the new
 * version anyway, and a later deploy shows the banner again.
 *
 * `role="status"`, not `alert`: important, but not an error or a danger.
 */
export function UpdateBanner({ onReload, onDismiss }) {
  return (
    <div className={styles.banner} role="status">
      <p className={styles.message}>A new version of LodgeKeep is available. Reload to get the latest features and fixes.</p>
      <div className={styles.actions}>
        <Button size="compact" onClick={onReload}>
          Reload now
        </Button>
        <Button size="compact" variant="ghost" onClick={onDismiss}>
          Later
        </Button>
      </div>
    </div>
  );
}
