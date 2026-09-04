import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { setupApi, reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './BookingForm.module.css';
import styles from './BookingScreen.module.css';

const BOARDS = [
  { key: 'arrivals', label: 'Arrivals' },
  { key: 'departures', label: 'Departures' },
  { key: 'in-house', label: 'In-House' },
];

/**
 * PRODUCT_REQUIREMENTS.md §3.3: "Arrivals / Departures / In-House — three
 * tabbed filterable tables ... primary action button Check In/Check Out"
 * and "Room move/upgrade — side-by-side current vs target room, reason
 * field."
 */
export function FrontDeskTab() {
  const [board, setBoard] = useState('arrivals');
  const [rows, setRows] = useState(null);
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);

  const [checkingIn, setCheckingIn] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [overrideDirty, setOverrideDirty] = useState(false);

  const [checkingOut, setCheckingOut] = useState(null);
  const [checkoutForm, setCheckoutForm] = useState({ scheduled_checkout_time: '', actual_checkout_time: '', late_checkout_fee: '', early_cutoff_time: '', early_departure_fee: '' });

  const [movingRoom, setMovingRoom] = useState(null);
  const [moveForm, setMoveForm] = useState({ new_room_id: '', reason: '' });

  const [submitting, setSubmitting] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState(null);

  async function reloadBoard(currentBoard = board) {
    try {
      const fn = currentBoard === 'arrivals' ? reservationsApi.listArrivals : currentBoard === 'departures' ? reservationsApi.listDepartures : reservationsApi.listInHouse;
      setRows(await fn());
    } catch (caught) {
      setRows([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load this board.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadBoard();
    setupApi.listRooms().then(setRooms).catch(() => setRooms([]));
  }, []);

  function switchBoard(key) {
    setBoard(key);
    setRows(null);
    reloadBoard(key);
  }

  async function handleCheckIn(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await reservationsApi.checkIn(checkingIn.id, { roomId, overrideDirty });
      setCheckingIn(null);
      setRoomId('');
      setOverrideDirty(false);
      await reloadBoard();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not check in this reservation.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckOut(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await reservationsApi.checkOut(checkingOut.id, {
        scheduledCheckoutTime: checkoutForm.scheduled_checkout_time || undefined,
        actualCheckoutTime: checkoutForm.actual_checkout_time || undefined,
        earlyCutoffTime: checkoutForm.early_cutoff_time || undefined,
        earlyDepartureFee: checkoutForm.early_departure_fee || undefined,
        lateCheckoutFee: checkoutForm.late_checkout_fee || undefined,
      });
      setCheckingOut(null);
      setCheckoutForm({ scheduled_checkout_time: '', actual_checkout_time: '', late_checkout_fee: '', early_cutoff_time: '', early_departure_fee: '' });
      setCheckoutSuccess(result?.fee ? `Checked out — ${result.fee.type.replace('_', ' ')} fee of ${result.fee.amount} posted to the folio.` : 'Checked out.');
      await reloadBoard();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not check out this reservation — the folio balance may not be settled.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRoomMove(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await reservationsApi.roomMove(movingRoom.id, { newRoomId: moveForm.new_room_id, reason: moveForm.reason });
      setMovingRoom(null);
      setMoveForm({ new_room_id: '', reason: '' });
      await reloadBoard();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not move this reservation to the new room.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.tabs} role="tablist" aria-label="Front desk boards">
        {BOARDS.map((b) => (
          <button
            key={b.key}
            type="button"
            role="tab"
            aria-selected={board === b.key}
            className={`${styles.tab} ${board === b.key ? styles.tabActive : ''}`.trim()}
            onClick={() => switchBoard(b.key)}
          >
            {b.label}
          </button>
        ))}
      </div>

      <DataTable
        title={BOARDS.find((b) => b.key === board).label}
        state={rows === null ? 'loading' : rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="Nothing on this board today."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          { key: 'adults', label: 'Adults', align: 'right' },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        errorMessage={error}
        toolbar={checkoutSuccess ? <p className={formStyles.disabledNotice}>{checkoutSuccess}</p> : undefined}
        actions={(row) => (
          <>
            {board === 'arrivals' && (
              <Button size="compact" onClick={() => setCheckingIn(row)}>
                Check In
              </Button>
            )}
            {board === 'departures' && (
              <Button size="compact" onClick={() => setCheckingOut(row)}>
                Check Out
              </Button>
            )}
            {board === 'in-house' && (
              <>
                <Button size="compact" variant="secondary" onClick={() => setMovingRoom(row)}>
                  Move Room
                </Button>
                <Button size="compact" onClick={() => setCheckingOut(row)}>
                  Check Out
                </Button>
              </>
            )}
          </>
        )}
      />

      {checkingIn && (
        <Card title={`Check in — ${checkingIn.confirmation_number}`}>
          <form className={formStyles.form} onSubmit={handleCheckIn}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Room</span>
              <select className={formStyles.select} value={roomId} onChange={(event) => setRoomId(event.target.value)} required>
                <option value="" disabled>
                  Select a room
                </option>
                {(rooms ?? []).map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_number} ({room.housekeeping_reported_status})
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.checkboxField}>
              <input
                type="checkbox"
                className={formStyles.checkbox}
                checked={overrideDirty}
                onChange={(event) => setOverrideDirty(event.target.checked)}
              />
              <span className={formStyles.label}>Check in anyway if the room is not marked clean</span>
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting}>
                Confirm check-in
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCheckingIn(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {checkingOut && (
        <Card title={`Check out — ${checkingOut.confirmation_number}`}>
          <p className={formStyles.disabledNotice}>
            Leave the times blank for a standard checkout with no early/late fee.
          </p>
          <form className={formStyles.form} onSubmit={handleCheckOut}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Scheduled checkout (HH:MM)</span>
                <input
                  className={formStyles.input}
                  placeholder="11:00"
                  value={checkoutForm.scheduled_checkout_time}
                  onChange={(event) => setCheckoutForm({ ...checkoutForm, scheduled_checkout_time: event.target.value })}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Actual checkout (HH:MM)</span>
                <input
                  className={formStyles.input}
                  placeholder="14:00"
                  value={checkoutForm.actual_checkout_time}
                  onChange={(event) => setCheckoutForm({ ...checkoutForm, actual_checkout_time: event.target.value })}
                />
              </label>
            </div>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Late checkout fee</span>
                <input
                  className={formStyles.input}
                  placeholder="25.00"
                  value={checkoutForm.late_checkout_fee}
                  onChange={(event) => setCheckoutForm({ ...checkoutForm, late_checkout_fee: event.target.value })}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Early departure fee</span>
                <input
                  className={formStyles.input}
                  placeholder="50.00"
                  value={checkoutForm.early_departure_fee}
                  onChange={(event) => setCheckoutForm({ ...checkoutForm, early_departure_fee: event.target.value })}
                />
              </label>
            </div>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting}>
                Confirm check-out
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCheckingOut(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {movingRoom && (
        <Card title={`Move room — ${movingRoom.confirmation_number}`}>
          <form className={formStyles.form} onSubmit={handleRoomMove}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>New room</span>
              <select
                className={formStyles.select}
                value={moveForm.new_room_id}
                onChange={(event) => setMoveForm({ ...moveForm, new_room_id: event.target.value })}
                required
              >
                <option value="" disabled>
                  Select a room
                </option>
                {(rooms ?? []).map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_number}
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Reason</span>
              <input
                className={formStyles.input}
                value={moveForm.reason}
                onChange={(event) => setMoveForm({ ...moveForm, reason: event.target.value })}
                required
              />
            </label>
            <div className={formStyles.actionsRow}>
              <Button type="submit" loading={submitting}>
                Confirm move
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMovingRoom(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
