import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { housekeepingApi, setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './HousekeepingForm.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const ASSIGNMENT_TONE = { assigned: 'neutral', in_progress: 'info', completed: 'success' };

/**
 * PRODUCT_REQUIREMENTS.md §3.6: "Housekeeping board — rooms grouped by
 * attendant assignment, with status update controls sized for touch (this
 * is the mobile-first screen, 3.18)." `Button`'s default size is already
 * the 44px touch-safe control (see its own header) — this tab never opts
 * into `size="compact"`, unlike the desktop-oriented Setup/Booking tables.
 *
 * "Attendant" is entered as a raw user id, not picked from a name list — no
 * staff-directory endpoint exists yet in this codebase (`GET /users` was
 * never built; PLAN.md's own Phase 0/1 status calls user management "a UI
 * gap"). Flagged here rather than inventing a fake picker.
 */
export function BoardTab({ isOffline = false }) {
  const [businessDate, setBusinessDate] = useState(todayIso());
  const [board, setBoard] = useState(null);
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ room_id: '', attendant_user_id: '' });
  const [submitting, setSubmitting] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);

  async function reload(date = businessDate) {
    try {
      setBoard(await housekeepingApi.getBoard(date));
    } catch (caught) {
      setBoard([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the housekeeping board.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    setupApi.listRooms().then(setRooms).catch(() => setRooms([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch, same pattern FrontDeskTab's own effect documents
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await housekeepingApi.createAssignment({ roomId: form.room_id, attendantUserId: form.attendant_user_id, businessDate });
      setForm({ room_id: '', attendant_user_id: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the assignment.');
    } finally {
      setSubmitting(false);
    }
  }

  async function advanceStatus(assignment) {
    const next = assignment.status === 'assigned' ? 'in_progress' : 'completed';
    setUpdatingId(assignment.id);
    setError(null);
    try {
      await housekeepingApi.updateAssignment(assignment.id, { status: next });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update this assignment.');
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div>
      {/* Outside DataTable's own toolbar slot, deliberately: Card (which
          DataTable wraps) only renders `children` — toolbar included —
          while `state === 'success'`. A date picker inside that slot would
          become permanently unreachable the moment a date has zero
          assignments, which is the ordinary case, not an edge case. */}
      <label className={formStyles.field}>
        <span className={formStyles.label}>Business date</span>
        <input
          type="date"
          className={formStyles.input}
          value={businessDate}
          onChange={(event) => {
            setBusinessDate(event.target.value);
            setBoard(null);
            reload(event.target.value);
          }}
        />
      </label>
      <DataTable
        title="Today's board"
        state={board === null ? 'loading' : board.length === 0 ? 'empty' : 'success'}
        emptyMessage="No rooms assigned for this date yet."
        columns={[
          { key: 'room_number', label: 'Room' },
          { key: 'attendant_user_id', label: 'Attendant' },
          {
            key: 'status',
            label: 'Status',
            render: (row) => <StatusPill tone={ASSIGNMENT_TONE[row.status] ?? 'neutral'} label={row.status.replace('_', ' ')} />,
          },
          {
            key: 'has_discrepancy',
            label: 'Discrepancy',
            render: (row) => (row.has_discrepancy ? <StatusPill tone="danger" label="Open" /> : <StatusPill tone="neutral" label="None" />),
          },
        ]}
        rows={board ?? []}
        rowKey={(row) => row.id}
        errorMessage={error}
        actions={(row) =>
          row.status !== 'completed' && (
            <Button loading={updatingId === row.id} disabled={isOffline} onClick={() => advanceStatus(row)}>
              {row.status === 'assigned' ? 'Start cleaning' : 'Mark complete'}
            </Button>
          )
        }
      />

      <Card title="Assign a room">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <p className={formStyles.disabledNotice}>
          Attendant is entered by staff id — there is no staff directory to pick a name from yet.
        </p>
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
              <span className={formStyles.label}>Attendant staff id</span>
              <input
                className={formStyles.input}
                value={form.attendant_user_id}
                onChange={(event) => setForm({ ...form, attendant_user_id: event.target.value })}
                placeholder="e.g. 2"
                required
              />
            </label>
          </div>
          {isOffline && (
            <p role="alert" className={formStyles.errorBanner}>
              You&rsquo;re offline — assignments are disabled until the connection returns.
            </p>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting} disabled={isOffline}>
              Assign
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
