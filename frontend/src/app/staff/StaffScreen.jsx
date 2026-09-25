import { UsersTab } from '../setup/UsersTab.jsx';
import styles from './StaffScreen.module.css';

/**
 * Gap closure (user-reported, production): clicking "Staff" in the sidebar
 * bounced to the Home dashboard. `nav-config.js` has always listed a
 * `staff` item (PRODUCT_REQUIREMENTS.md's App-shell spec names it), but
 * `main.jsx`'s screen switch had no branch for it, so it fell through to
 * the default case — the same defect "Rooms" had.
 *
 * Staff management already exists: `UsersTab` (list, invite, change role,
 * deactivate, pending invitations), backed by `/users`, gated on
 * `setup.view`/`setup.manage`. This screen is a dedicated day-to-day entry
 * point to that same tab, not a second copy — the pattern `RoomsScreen`
 * established for `RoomTypesTab`/`RoomsTab`. The per-action `setup.manage`
 * check stays with the API; the nav item is gated on `setup.view`.
 */
export function StaffScreen({ activeProperty, isOffline = false }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Staff</h1>
      <UsersTab disabled={!activeProperty} isOffline={isOffline} />
    </div>
  );
}
