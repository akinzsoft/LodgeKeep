import { formatInZone } from './format.js';
import styles from './DoorAccess.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.23 "Degraded-mode banner": this property's
 * locks (HiRead ProUSB, standalone offline) cannot report events live, so
 * every Door Access screen states plainly that detection is retrospective
 * and depends on staff pulling the lock log, with the last import date.
 *
 * Deliberately has no dismiss control — the same reasoning
 * `ImpersonationBanner` documents: a manager who believes they would be
 * alerted in real time, and isn't, is worse off than one who knows the
 * limitation. Rendered above the tabs, so it is on every tab.
 *
 * @param {{lastImportAt: string|null, timezone: string|null, supportsRealtime: boolean}|null} config
 */
export function RetrospectiveBanner({ config }) {
  const lastImport = config?.lastImportAt ? formatInZone(config.lastImportAt, config.timezone) : 'never';
  return (
    <div className={styles.banner} role="note" aria-label="Detection is retrospective">
      <p className={styles.bannerHeading}>Detection is retrospective — this is not live monitoring.</p>
      <p className={styles.bannerText}>
        These locks do not report door openings in real time. Alerts are raised only when someone pulls the audit trail
        from the locks with the handheld reader and uploads it here, so anything found may have happened days ago. Pull
        and upload lock logs on a regular schedule.
      </p>
      <p className={styles.bannerText}>
        Last lock log import: <strong>{lastImport}</strong>
      </p>
    </div>
  );
}
