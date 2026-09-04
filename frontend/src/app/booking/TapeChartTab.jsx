import { useEffect, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { setupApi, reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './BookingForm.module.css';
import styles from './TapeChartTab.module.css';

const WINDOW_NIGHTS = 14;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * PRODUCT_REQUIREMENTS.md §3.2: "Calendar/tape chart — rooms down the side,
 * dates across the top, reservation bars per room, drag to move/extend ...
 * the single most-used screen for reservations staff." This session's
 * confirmed scope: ship the grid-with-bars version, WITHOUT drag-to-move —
 * room moves happen through Front Desk's dedicated form instead.
 *
 * ── ROOM TYPE ROWS, NOT PHYSICAL ROOM ROWS ──────────────────────────────
 *
 * A traditional tape chart plots one row per PHYSICAL room, because a
 * booking is normally assigned a specific room at booking time. This
 * session's confirmed decision was the opposite (see the `reservations`
 * migration's own header): a specific room is assigned only at check-in, so
 * a future confirmed reservation has no room to plot a bar against yet —
 * only a room TYPE and a date range. Rows here are therefore room types,
 * and each cell is that type's sellable position for one date (from the
 * same `checkAvailability` the Availability tab uses), not an individual
 * guest's bar. This is the honest shape given the room-assignment-timing
 * decision already made, not a shortcut — it answers the same question a
 * tape chart exists for ("what's the booking pressure across dates,
 * room type by room type") without claiming a room-level view this
 * pass's data model cannot actually support before check-in.
 */
export function TapeChartTab() {
  const [roomTypes, setRoomTypes] = useState(null);
  const [windowStart, setWindowStart] = useState(new Date().toISOString().slice(0, 10));
  const [grid, setGrid] = useState(null);
  const [error, setError] = useState(null);

  async function reloadGrid(start) {
    try {
      const types = roomTypes ?? (await setupApi.listRoomTypes());
      if (!roomTypes) setRoomTypes(types);

      const end = addDays(start, WINDOW_NIGHTS);
      const results = await Promise.all(
        types.map((rt) => reservationsApi.checkAvailability({ roomTypeId: rt.id, arrivalDate: start, departureDate: end }))
      );
      setGrid(
        types.map((rt, index) => ({
          roomType: rt,
          nights: results[index].nights,
        }))
      );
    } catch (caught) {
      setGrid([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the tape chart.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadGrid(windowStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- windowStart changes are handled by the Button below, not by re-running this effect
  }, []);

  function cellClass(night) {
    if (night.sellable === 0) return styles.full;
    if (night.sellable <= Math.max(1, Math.round(night.physicalCount * 0.2))) return styles.tight;
    return styles.available;
  }

  const dates = grid && grid[0] ? grid[0].nights.map((n) => n.stayDate) : [];

  return (
    <Card title="Tape chart">
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <div className={`${formStyles.actionsRow} ${styles.controls}`}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Window start</span>
          <input
            type="date"
            className={formStyles.input}
            value={windowStart}
            onChange={(event) => setWindowStart(event.target.value)}
          />
        </label>
        <Button type="button" onClick={() => reloadGrid(windowStart)}>
          Go
        </Button>
      </div>

      {grid === null ? (
        <p>Loading…</p>
      ) : grid.length === 0 ? (
        <p>No room types configured yet.</p>
      ) : (
        <div className={styles.wrapper}>
          <div
            className={styles.grid}
            style={{ gridTemplateColumns: `10rem repeat(${dates.length}, minmax(2.5rem, 1fr))` }}
          >
            <div className={styles.headerCell}>Room type</div>
            {dates.map((date) => (
              <div key={date} className={styles.headerCell}>
                {date.slice(5)}
              </div>
            ))}

            {grid.map((row) => (
              <div key={row.roomType.id} style={{ display: 'contents' }}>
                <div className={styles.rowLabel}>{row.roomType.name}</div>
                {row.nights.map((night) => (
                  <div
                    key={night.stayDate}
                    className={`${styles.cell} ${cellClass(night)}`}
                    title={`${row.roomType.name}, ${night.stayDate}: ${night.sellable} of ${night.physicalCount} sellable`}
                  >
                    {night.sellable}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className={styles.legend}>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchAvailable}`} /> Available
        </span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchTight}`} /> Tight (≤20%)
        </span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchFull}`} /> Fully sold
        </span>
      </p>
    </Card>
  );
}
