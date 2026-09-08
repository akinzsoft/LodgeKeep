import { useState } from 'react';
import { RoomTypesTab } from '../setup/RoomTypesTab.jsx';
import { RoomsTab } from '../setup/RoomsTab.jsx';
import styles from './RoomsScreen.module.css';

/**
 * Gap closure (user-reported): "Rooms" is a real MAIN-nav item in
 * PRODUCT_REQUIREMENTS.md's own literal App-shell spec — unlike Front
 * Desk/Housekeeping/Cashiering/POS, which each had to be FILED under MAIN
 * with no separate slot of their own, "Rooms" already had one. It was
 * never wired to anything in `main.jsx`'s screen switch, though — clicking
 * it silently fell through to the default case and showed the Home
 * dashboard instead, with no error and no indication anything was wrong.
 *
 * Reuses `RoomTypesTab`/`RoomsTab` (`app/setup/`) directly rather than a
 * second copy — the same real CRUD/bulk-add this session's earlier
 * work already built for Setup's own onboarding flow, just reachable from
 * a dedicated day-to-day nav item instead of buried in Setup's six-tab
 * wizard. `--domain-rooms` (tokens.css: "rooms, inventory, housekeeping")
 * is the exact accent DESIGN_SYSTEM.md's own token set already reserved
 * for this domain — Housekeeping already uses it, confirming a real
 * top-level Rooms screen was anticipated, just never built.
 *
 * No `isOffline` prop, unlike every other top-level screen in this app:
 * `RoomTypesTab`/`RoomsTab` (reused unchanged from `app/setup/`) have never
 * accepted or acted on one, even under `SetupScreen`'s own existing call to
 * them — neither tab's submit button actually disables while offline. A
 * banner here claiming changes are "disabled" would be false; the honest
 * fix is in those two tabs themselves, a pre-existing gap this pass did
 * not introduce and is out of scope to silently paper over with a banner
 * that doesn't match real behaviour.
 *
 * Gap closure (user-reported): "on Rooms page on list of rooms add if i
 * click on any roomtype it shld bring all rooms associated to that room
 * type with status" — clicking "View rooms" on a Room Types row switches to
 * the Rooms tab pre-filtered to that type. `roomTypeFilter` lives here, not
 * in either tab, since it's the thing that ties the two tabs together;
 * `RoomTypesTab`/`RoomsTab` themselves stay unaware of each other, same as
 * they are under `SetupScreen`.
 */
const TABS = [
  { key: 'room-types', label: 'Room Types' },
  { key: 'rooms', label: 'Rooms' },
];

export function RoomsScreen({ activeProperty }) {
  const [tab, setTab] = useState('room-types');
  const [roomTypeFilter, setRoomTypeFilter] = useState(null);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Rooms</h1>

      <div className={styles.tabs} role="tablist" aria-label="Rooms sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`.trim()}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.panel}>
        {tab === 'room-types' && (
          <RoomTypesTab
            activeProperty={activeProperty}
            disabled={!activeProperty}
            onViewRooms={(roomType) => {
              setRoomTypeFilter(roomType.id);
              setTab('rooms');
            }}
          />
        )}
        {tab === 'rooms' && (
          <RoomsTab
            activeProperty={activeProperty}
            disabled={!activeProperty}
            filterRoomTypeId={roomTypeFilter}
            onClearFilter={() => setRoomTypeFilter(null)}
          />
        )}
      </div>
    </div>
  );
}
