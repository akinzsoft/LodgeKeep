import styles from './RoomKeypad.module.css';

/** Why a room cannot be picked for these dates — `GET /reservations/room-board`'s `reason`. */
const REASON_LABEL = {
  occupied: 'Occupied',
  reserved: 'Reserved',
  not_clean: 'Not clean yet',
  out_of_order: 'Out of order',
  discrepancy: 'Under review',
};

/**
 * RoomKeypad — the booking form's room keypad (user-requested: "a standard
 * keypad that shows all available rooms with an indicator, while rooms
 * that have been taken show Not available"). Confirmed with the user: the
 * searched room type only, for the searched dates; tapping an available
 * room picks it as the booking's preferred room (tap it again to clear) —
 * still a request, never a lock, like the "Preferred room" list it drives.
 *
 * Every tile carries its state in words ("Available" / "Not available"
 * plus why, or "Selected"), never colour alone (DESIGN_SYSTEM.md §1). A
 * taken room is a disabled button, so it can be seen but not picked.
 *
 * @param {Array<{id, room_number, floor, available, reason}>|null} rooms  null while loading
 * @param {string} selectedId   the booking's preferred room id, '' for none
 * @param {(id: string) => void} onSelect   '' clears the choice
 * @param {boolean} [disabled]  offline, submitting, or already booked
 * @param {boolean} [failed]    the rooms could not be loaded
 */
export function RoomKeypad({ rooms, roomTypeName, selectedId, onSelect, disabled = false, failed = false }) {
  if (failed) return <p className={styles.hint}>The rooms could not be loaded. Search again to retry.</p>;
  if (rooms === null) return <p className={styles.hint}>Loading rooms…</p>;
  if (rooms.length === 0) return <p className={styles.hint}>This room type has no rooms set up yet.</p>;

  const availableCount = rooms.filter((room) => room.available).length;
  return (
    <section className={styles.keypad} aria-label="Rooms">
      <div className={styles.heading}>
        <h3 className={styles.title}>Rooms{roomTypeName ? ` — ${roomTypeName}` : ''}</h3>
        <p className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.dot} ${styles.dotAvailable}`} aria-hidden="true" />
            {availableCount} available
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.dot} ${styles.dotTaken}`} aria-hidden="true" />
            {rooms.length - availableCount} not available
          </span>
        </p>
      </div>
      <p className={styles.hint}>Tap an available room to pick it for this guest. It is a request — the room is confirmed at check-in.</p>
      <div className={styles.grid}>
        {rooms.map((room) => {
          const selected = String(room.id) === String(selectedId);
          const state = selected ? 'Selected' : room.available ? 'Available' : 'Not available';
          const detail = !room.available ? REASON_LABEL[room.reason] ?? null : room.floor ? `Floor ${room.floor}` : null;
          return (
            <button
              key={room.id}
              type="button"
              className={`${styles.tile} ${selected ? styles.tileSelected : room.available ? styles.tileAvailable : styles.tileTaken}`}
              disabled={!room.available || disabled}
              aria-pressed={room.available ? selected : undefined}
              aria-label={`Room ${room.room_number}, ${state}${detail && !room.available ? ` — ${detail}` : ''}`}
              onClick={() => onSelect(selected ? '' : String(room.id))}
            >
              <span className={styles.number}>{room.room_number}</span>
              <span className={styles.state}>
                <span className={`${styles.dot} ${room.available ? styles.dotAvailable : styles.dotTaken}`} aria-hidden="true" />
                {state}
              </span>
              {detail && <span className={styles.detail}>{detail}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
