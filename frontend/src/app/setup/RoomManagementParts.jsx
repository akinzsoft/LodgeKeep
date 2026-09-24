import { Button } from '../../shared/components/index.js';
import styles from './RoomsTab.module.css';

/**
 * Groups blocked rooms by the sentence that blocked them, so a batch of
 * rooms that all fail for the same reason (e.g. "would oversell Deluxe on
 * 12 Oct") reads as ONE line naming every room, not a wall of identical
 * ones. The sentences come straight from the server (`reasons[].message`) —
 * this never re-derives a reason, so what the server enforces and what the
 * screen says can't drift apart.
 */
export function groupBlockedByMessage(blocked) {
  const groups = new Map();
  for (const entry of blocked) {
    const label = entry.room_number ?? 'unknown room';
    for (const reason of entry.reasons ?? []) {
      if (!groups.has(reason.message)) groups.set(reason.message, []);
      groups.get(reason.message).push(label);
    }
  }
  return [...groups.entries()].map(([message, rooms]) => ({ message, rooms }));
}

/**
 * The all-or-nothing outcome: a change was refused, NOTHING was applied, and
 * here is every room that blocked it and why. The selection is kept by the
 * caller so the user can deselect the blocked rooms and retry.
 */
export function BlockedRoomsPanel({ blocked, onDismiss }) {
  const groups = groupBlockedByMessage(blocked);
  return (
    <div role="alert" className={styles.blockedPanel}>
      <p className={styles.blockedTitle}>
        Nothing was changed. {blocked.length === 1 ? '1 room is' : `${blocked.length} rooms are`} blocked:
      </p>
      <ul className={styles.blockedList}>
        {groups.map(({ message, rooms }) => (
          <li key={message}>
            {rooms.length > 1 ? `Rooms ${rooms.join(', ')}` : `Room ${rooms[0]}`} — {message}
          </li>
        ))}
      </ul>
      <Button size="compact" variant="secondary" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** "CONF1, CONF2 and 3 more" — a cleared-preferences list can be long; the full list is in the audit log. */
export function summariseReservations(cleared, limit = 5) {
  const shown = cleared.slice(0, limit).map((row) => row.confirmation_number);
  const extra = cleared.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
