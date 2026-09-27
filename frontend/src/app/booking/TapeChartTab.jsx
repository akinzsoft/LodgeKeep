import { useEffect, useRef, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { setupApi, reservationsApi, ApiError } from '../../shared/api/index.js';
import { addDays, formatDate, weekdayOf } from '../../shared/format/dates.js';
import formStyles from './BookingForm.module.css';
import styles from './TapeChartTab.module.css';

const WINDOW_NIGHTS = 14;
const STEP_NIGHTS = 7;

/**
 * Available / tight / full for one room type on one night. "Tight" means at
 * most a fifth of the type is still free AND something has sold — a type
 * with a single room is simply available or full, never "tight" while its
 * only room is free (the old rule flagged 1 of 1 free as tight).
 */
export function nightTone(night) {
  if (night.sellable <= 0) return 'full';
  if (night.physicalCount > 0 && night.sellable < night.physicalCount && night.sellable / night.physicalCount <= 0.2) return 'tight';
  return 'available';
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
 *
 * Bug fix (found while live-testing the Booking screen, not by inspection):
 * `windowStart`'s initial value defaulted to the BROWSER's own wall-clock
 * "today" — ARCHITECTURE.md §6's "business date ≠ wall clock" rule violated
 * in exactly the one place on this whole screen it hadn't already been
 * checked (`AvailabilityTab`'s own "rooms free right now" panel already
 * compares against `activeProperty.current_business_date`, never `new
 * Date()`). `BookingScreen` was already passing `activeProperty` down to
 * this component; nothing here ever read it. A property whose business date
 * has drifted from calendar-today (a lapsed night audit, or simply a
 * different timezone) would open this chart on the wrong window by
 * default — silently correct only by coincidence on any day the two happen
 * to match, which is exactly why this went unnoticed until now. Falls back
 * to wall-clock only when the property genuinely has no business date yet
 * (`current_business_date: null` — not yet opened, PRODUCT_REQUIREMENTS.md
 * §3.19's own setup wizard hasn't reached that step), the same graceful
 * degradation `BusinessDateIndicator`'s own "Not set" fallback already
 * established rather than crashing on a null date string.
 */
export function TapeChartTab({ activeProperty }) {
  const businessDate = activeProperty?.current_business_date ?? new Date().toISOString().slice(0, 10);
  const [roomTypes, setRoomTypes] = useState(null);
  const [windowStart, setWindowStart] = useState(businessDate);
  const [grid, setGrid] = useState(null);
  const [error, setError] = useState(null);

  // Week buttons can be clicked faster than the grid loads — only the latest request's answer may land.
  const requestSeq = useRef(0);

  async function reloadGrid(start) {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    try {
      const types = roomTypes ?? (await setupApi.listRoomTypes());
      if (!roomTypes) setRoomTypes(types);

      const end = addDays(start, WINDOW_NIGHTS);
      const results = await Promise.all(
        types.map((rt) => reservationsApi.checkAvailability({ roomTypeId: rt.id, arrivalDate: start, departureDate: end }))
      );
      if (seq !== requestSeq.current) return;
      setError(null);
      setGrid(
        types.map((rt, index) => ({
          roomType: rt,
          nights: results[index].nights,
        }))
      );
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setGrid([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the tape chart.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadGrid(windowStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- windowStart changes are handled by the Button below, not by re-running this effect
  }, []);

  const TONE_CLASS = { full: styles.full, tight: styles.tight, available: styles.available };
  const TONE_WORD = { full: 'fully sold', tight: 'nearly full', available: 'available' };

  function showWindow(start) {
    setWindowStart(start);
    reloadGrid(start);
  }

  const dates = grid && grid[0] ? grid[0].nights.map((n) => n.stayDate) : [];

  return (
    <Card title="Tape chart">
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <div className={styles.controls}>
        <div className={styles.navButtons} role="group" aria-label="Move the chart">
          <Button type="button" variant="secondary" size="compact" onClick={() => showWindow(addDays(windowStart, -STEP_NIGHTS))}>
            ◀ Previous week
          </Button>
          <Button type="button" variant="secondary" size="compact" onClick={() => showWindow(businessDate)} disabled={windowStart === businessDate}>
            Today
          </Button>
          <Button type="button" variant="secondary" size="compact" onClick={() => showWindow(addDays(windowStart, STEP_NIGHTS))}>
            Next week ▶
          </Button>
        </div>
        <p className={styles.range}>
          {formatDate(windowStart, { weekday: true, year: false })} – {formatDate(addDays(windowStart, WINDOW_NIGHTS - 1), { weekday: true })}
        </p>
        <label className={`${formStyles.field} ${styles.jump}`}>
          <span className={formStyles.label}>Jump to date</span>
          <input
            type="date"
            className={formStyles.input}
            value={windowStart}
            onChange={(event) => {
              if (event.target.value) showWindow(event.target.value);
            }}
          />
        </label>
      </div>

      {grid === null ? (
        <p>Loading…</p>
      ) : grid.length === 0 ? (
        <p>No room types configured yet.</p>
      ) : (
        <div className={styles.wrapper}>
          <div
            className={styles.grid}
            style={{ gridTemplateColumns: `minmax(8rem, 10rem) repeat(${dates.length}, minmax(2.75rem, 1fr))` }}
          >
            <div className={styles.headerCell}>Room type</div>
            {dates.map((date) => (
              <div
                key={date}
                className={`${styles.headerCell} ${styles.dateHeader} ${date === businessDate ? styles.todayHeader : ''}`}
                aria-current={date === businessDate ? 'date' : undefined}
              >
                <span className={styles.headerWeekday}>{weekdayOf(date)}</span>
                <span>{Number(date.slice(8, 10))}</span>
              </div>
            ))}

            {grid.map((row) => (
              <div key={row.roomType.id} style={{ display: 'contents' }}>
                <div className={styles.rowLabel}>{row.roomType.name}</div>
                {row.nights.map((night) => {
                  const tone = nightTone(night);
                  return (
                    <div
                      key={night.stayDate}
                      className={`${styles.cell} ${TONE_CLASS[tone]} ${night.stayDate === businessDate ? styles.todayCell : ''}`}
                      title={`${row.roomType.name}, ${formatDate(night.stayDate, { weekday: true })}: ${night.sellable} of ${night.physicalCount} rooms free (${TONE_WORD[tone]})`}
                    >
                      {night.sellable}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className={styles.legend}>
        <span>Each cell shows how many rooms of that type are still free that night.</span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchAvailable}`} /> Available
        </span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchTight}`} /> Nearly full (a fifth or less free)
        </span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSwatchFull}`} /> Fully sold
        </span>
      </p>
    </Card>
  );
}
