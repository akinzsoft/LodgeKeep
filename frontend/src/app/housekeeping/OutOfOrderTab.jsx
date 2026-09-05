import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { housekeepingApi, setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './HousekeepingForm.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.6/§3.7: "Maintenance / out-of-order — raise,
 * track, and clear OOO/OOS with date ranges; rooms marked OOO must visibly
 * drop out of sellable inventory" — verified live end to end against
 * `/api/v1/availability` (`src/shared/room-availability.js` on the
 * backend), not just displayed here.
 */
export function OutOfOrderTab({ isOffline = false }) {
  const [periods, setPeriods] = useState(null);
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ room_id: '', type: 'ooo', reason: '', start_date: '', end_date: '' });
  const [submitting, setSubmitting] = useState(false);

  async function reload() {
    try {
      setPeriods(await housekeepingApi.listOutOfOrderPeriods());
    } catch (caught) {
      setPeriods([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load out-of-order periods.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    setupApi.listRooms().then(setRooms).catch(() => setRooms([]));
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await housekeepingApi.createOutOfOrderPeriod({
        roomId: form.room_id,
        type: form.type,
        reason: form.reason,
        startDate: form.start_date,
        endDate: form.end_date,
      });
      setForm({ room_id: '', type: 'ooo', reason: '', start_date: '', end_date: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not schedule this out-of-order period.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseNow(period) {
    try {
      await housekeepingApi.closeOutOfOrderPeriod(period.id, new Date().toISOString().slice(0, 10));
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not close this period.');
    }
  }

  return (
    <div>
      <DataTable
        title="Out-of-order / out-of-service periods"
        state={periods === null ? 'loading' : periods.length === 0 ? 'empty' : 'success'}
        emptyMessage="No out-of-order periods scheduled."
        columns={[
          { key: 'room_id', label: 'Room' },
          { key: 'type', label: 'Type' },
          { key: 'reason', label: 'Reason' },
          { key: 'start_date', label: 'Start' },
          { key: 'end_date', label: 'End' },
        ]}
        rows={periods ?? []}
        rowKey={(row) => row.id}
        errorMessage={error}
        actions={(row) => (
          <Button variant="secondary" disabled={isOffline} onClick={() => handleCloseNow(row)}>
            Close now
          </Button>
        )}
      />

      <Card title="Schedule an out-of-order period">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreate}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Room</span>
              <select
                className={formStyles.select}
                value={form.room_id}
                onChange={(event) => setForm({ ...form, room_id: event.target.value })}
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
              <span className={formStyles.label}>Type</span>
              <select className={formStyles.select} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                <option value="ooo">Out of order</option>
                <option value="oos">Out of service</option>
              </select>
            </label>
          </div>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Reason</span>
            <input
              className={formStyles.input}
              value={form.reason}
              onChange={(event) => setForm({ ...form, reason: event.target.value })}
              required
            />
          </label>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Start date</span>
              <input
                type="date"
                className={formStyles.input}
                value={form.start_date}
                onChange={(event) => setForm({ ...form, start_date: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>End date</span>
              <input
                type="date"
                className={formStyles.input}
                value={form.end_date}
                onChange={(event) => setForm({ ...form, end_date: event.target.value })}
                required
              />
            </label>
          </div>
          {isOffline && (
            <p role="alert" className={formStyles.errorBanner}>
              You&rsquo;re offline — scheduling is disabled until the connection returns.
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Schedule
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
