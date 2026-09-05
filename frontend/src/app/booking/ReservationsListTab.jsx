import { useEffect, useState } from 'react';
import { DataTable, StatusPill, Button, ConfirmDialog } from '../../shared/components/index.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';
import { statusTone, statusLabel } from './status.js';
import formStyles from './BookingForm.module.css';

const STATUS_FILTERS = ['', 'confirmed', 'tentative', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'waitlisted'];

/** PRODUCT_REQUIREMENTS.md §3.2: "Reservation list — filter by status ... date range, source." Source (market segment/booking source) has no data to filter by yet — those columns are nullable/deferred (see the reservations migration's own header). */
export function ReservationsListTab({ isOffline = false } = {}) {
  const [reservations, setReservations] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  async function reload(currentStatus = status) {
    try {
      setReservations(await reservationsApi.listReservations(currentStatus ? { status: currentStatus } : {}));
    } catch (caught) {
      setReservations([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load reservations.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is redefined every render and read here only for the mount-time fetch (status is still its initial value at that point); listing it as a dep would re-run this effect on every render since it's a new function reference each time. Status-change reloads already go through the select's onChange, which calls reload(event.target.value) explicitly.
  }, []);

  async function handleCancel(reason) {
    try {
      await reservationsApi.cancelReservation(cancelling.id, reason);
      setCancelling(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel the reservation.');
      setCancelling(null);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {/* Outside DataTable's own toolbar slot, deliberately: Card only
          renders `children` — toolbar included — while `state ===
          'success'`. Filtering to a status with zero matches (e.g.
          "no_show") is a real, unremarkable case, not an edge case — a
          filter control that vanishes exactly then would trap the user on
          that filter with no way back. */}
      <label className={formStyles.field}>
        <span className={formStyles.label}>Status</span>
        <select
          className={formStyles.select}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            reload(event.target.value);
          }}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s || 'all'} value={s}>
              {s ? statusLabel(s) : 'All statuses'}
            </option>
          ))}
        </select>
      </label>
      <DataTable
        title="Reservations"
        state={reservations === null ? 'loading' : reservations.length === 0 ? 'empty' : 'success'}
        emptyMessage="No reservations match this filter."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          { key: 'adults', label: 'Adults', align: 'right' },
          {
            key: 'status',
            label: 'Status',
            render: (row) => <StatusPill tone={statusTone(row.status)} label={statusLabel(row.status)} />,
          },
        ]}
        rows={reservations ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          ['confirmed', 'tentative', 'waitlisted'].includes(row.status) && (
            // DESIGN_SYSTEM.md §2: cancellation releases inventory and is
            // consequential enough to disable while offline, same as the
            // financial-adjacent actions elsewhere in this module.
            <Button variant="danger" size="compact" disabled={isOffline} onClick={() => setCancelling(row)}>
              Cancel
            </Button>
          )
        }
        errorMessage={error}
      />

      {cancelling && (
        <ConfirmDialog
          title="Cancel reservation"
          consequence={`This cancels confirmation ${cancelling.confirmation_number}${['confirmed', 'tentative'].includes(cancelling.status) ? ' and releases its held inventory immediately' : ''}. This cannot be undone.`}
          requireReason
          confirmLabel="Confirm cancellation"
          onConfirm={handleCancel}
          onCancel={() => setCancelling(null)}
        />
      )}
    </>
  );
}
