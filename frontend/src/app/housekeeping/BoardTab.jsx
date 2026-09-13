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
 * Gap closure (user-reported): "all dirty rooms shld show and all
 * houseppers shld show i dont need to type anytin" — the room picker now
 * lists only rooms actually needing a housekeeper
 * (`housekeeping_reported_status === 'dirty'`), excluding a room already on
 * today's board (assigning it again would just hit
 * `CONFLICT_ASSIGNMENT_ALREADY_EXISTS`, since a room can only be assigned
 * once per business date). The attendant field is now a real `<select>`
 * sourced from `GET /housekeeping/attendants` (new — see that endpoint's
 * own header for why it's a dedicated read rather than reusing `GET
 * /users`), not a raw id typed by hand — and the board's own "Attendant"
 * column now resolves the same list to a real name instead of a bare id.
 *
 * Bug fix (see `HousekeepingScreen`'s own header): `businessDate` used to
 * default to `todayIso()` unconditionally, regardless of the property's own
 * `current_business_date` — wrong the moment the two drift (a lapsed night
 * audit, a different timezone), and a real, not cosmetic, wrongness: a
 * fresh assignment submitted on this default is tagged to whatever date is
 * showing. Falls back to `todayIso()` only when the property genuinely has
 * no business date configured yet.
 *
 * A second, more serious bug fix (user-reported "test Housekeeper," found by
 * live-testing the real flow end to end): "Mark complete" only ever called
 * `updateAssignment` — it never called `housekeepingApi.reportRoomStatus`,
 * the ONE function that actually writes `rooms.housekeeping_reported_status`
 * and feeds PRODUCT_REQUIREMENTS.md §3.6's discrepancy-detection mechanism.
 * Confirmed live against the real dev database: two real assignments the
 * user had already marked "completed" through this exact screen left both
 * rooms still reading `housekeeping_reported_status: 'dirty'` — a cleaned
 * room could never become sellable again through this workflow, and a
 * discrepancy could never be raised, since nothing ever submitted the
 * housekeeper's own occupancy observation `reportRoomStatus` compares
 * against `front_desk_status`. Confirmed with the user (AskUserQuestion)
 * to fold the report into the same "Mark complete" action rather than a
 * separate control, since a housekeeper is physically standing in the room
 * at exactly that moment — completing the assignment now also asks a real
 * vacant/occupied question and submits both together. `reportRoomStatus` is
 * called FIRST, `updateAssignment` second: if the assignment-completion
 * call then fails, the room's real status is still correctly reported and
 * the assignment can be retried on its own; the reverse order would have
 * silently reproduced this exact bug on that one failure path (an
 * assignment reading "completed" with the room's status never reported).
 */
export function BoardTab({ activeProperty, isOffline = false }) {
  const [businessDate, setBusinessDate] = useState(activeProperty?.current_business_date ?? todayIso());
  const [board, setBoard] = useState(null);
  const [rooms, setRooms] = useState(null);
  const [attendants, setAttendants] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ room_id: '', attendant_user_id: '' });
  const [submitting, setSubmitting] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [awaitingOccupancyId, setAwaitingOccupancyId] = useState(null);

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
    housekeepingApi.listAttendants().then(setAttendants).catch(() => setAttendants([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch, same pattern FrontDeskTab's own effect documents
  }, []);

  const assignedRoomIds = new Set((board ?? []).map((row) => String(row.room_id)));
  const dirtyUnassignedRooms = (rooms ?? []).filter(
    (room) => room.housekeeping_reported_status === 'dirty' && !assignedRoomIds.has(String(room.id))
  );
  const attendantName = (userId) => {
    const attendant = (attendants ?? []).find((a) => String(a.id) === String(userId));
    return attendant ? `${attendant.first_name} ${attendant.last_name}` : `Staff ${userId}`;
  };

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

  async function startCleaning(assignment) {
    setUpdatingId(assignment.id);
    setError(null);
    try {
      await housekeepingApi.updateAssignment(assignment.id, { status: 'in_progress' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update this assignment.');
    } finally {
      setUpdatingId(null);
    }
  }

  /**
   * Completing an assignment is also the one real moment this codebase can
   * ask a housekeeper what they actually observed — see this file's own
   * header for why `reportRoomStatus` is called before `updateAssignment`,
   * not after.
   */
  async function completeWithOccupancy(assignment, occupancyObserved) {
    setUpdatingId(assignment.id);
    setError(null);
    try {
      await housekeepingApi.reportRoomStatus(assignment.room_id, { cleanliness: 'clean', occupancyObserved });
      await housekeepingApi.updateAssignment(assignment.id, { status: 'completed' });
      setAwaitingOccupancyId(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not complete this assignment.');
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
          { key: 'attendant_user_id', label: 'Attendant', render: (row) => attendantName(row.attendant_user_id) },
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
        actions={(row) => {
          if (row.status === 'completed') return null;
          if (awaitingOccupancyId === row.id) {
            return (
              <div className={formStyles.occupancyPrompt}>
                <span className={formStyles.occupancyQuestion}>Room vacant or occupied now?</span>
                <Button
                  size="compact"
                  loading={updatingId === row.id}
                  disabled={isOffline}
                  onClick={() => completeWithOccupancy(row, 'vacant')}
                >
                  Vacant
                </Button>
                <Button
                  size="compact"
                  loading={updatingId === row.id}
                  disabled={isOffline}
                  onClick={() => completeWithOccupancy(row, 'occupied')}
                >
                  Occupied
                </Button>
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={updatingId === row.id}
                  onClick={() => setAwaitingOccupancyId(null)}
                >
                  Cancel
                </Button>
              </div>
            );
          }
          return (
            <Button
              loading={updatingId === row.id}
              disabled={isOffline}
              onClick={() => (row.status === 'assigned' ? startCleaning(row) : setAwaitingOccupancyId(row.id))}
            >
              {row.status === 'assigned' ? 'Start cleaning' : 'Mark complete'}
            </Button>
          );
        }}
      />

      <Card title="Assign a dirty room">
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreate}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Dirty room</span>
              <select
                className={formStyles.select}
                value={form.room_id}
                onChange={(event) => setForm({ ...form, room_id: event.target.value })}
                required
              >
                <option value="" disabled>
                  {rooms === null ? 'Loading rooms…' : 'Select a room'}
                </option>
                {dirtyUnassignedRooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_number}
                  </option>
                ))}
              </select>
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Housekeeper</span>
              <select
                className={formStyles.select}
                value={form.attendant_user_id}
                onChange={(event) => setForm({ ...form, attendant_user_id: event.target.value })}
                required
              >
                <option value="" disabled>
                  {attendants === null ? 'Loading housekeepers…' : 'Select a housekeeper'}
                </option>
                {(attendants ?? []).map((attendant) => (
                  <option key={attendant.id} value={attendant.id}>
                    {attendant.first_name} {attendant.last_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {rooms !== null && dirtyUnassignedRooms.length === 0 && (
            <p className={formStyles.disabledNotice}>No dirty, unassigned rooms right now.</p>
          )}
          {attendants !== null && attendants.length === 0 && (
            <p className={formStyles.disabledNotice}>No housekeeping staff on file for this property yet.</p>
          )}
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
