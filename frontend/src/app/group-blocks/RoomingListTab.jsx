import { useEffect, useState } from 'react';
import { DataTable, StatusPill } from '../../shared/components/index.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './GBForm.module.css';

const STATUS_TONE = {
  waitlisted: 'neutral',
  tentative: 'warning',
  confirmed: 'info',
  checked_in: 'success',
  checked_out: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
  expired: 'neutral',
};

/**
 * RoomingListTab — PLAN.md Phase 4 (Group Blocks). This session's confirmed
 * decision: no separate rooming-list roster table — a rooming-list "entry"
 * is simply a reservation created the normal way with `group_block_id` set
 * (the Booking screen's own form gains an optional Group Block picker for
 * this). Deliberately read-only here, no inline booking form, to avoid a
 * second, parallel reservation-creation implementation.
 */
export function RoomingListTab({ block }) {
  const [reservations, setReservations] = useState(null);
  const [error, setError] = useState(null);

  async function reload() {
    if (!block) return;
    setError(null);
    try {
      setReservations(await reservationsApi.listReservations({ groupBlockId: block.id }));
    } catch (caught) {
      setReservations([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load this block\'s rooming list.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount/block-change; no data-fetching library exists yet to own this
    reload();
  }, [block?.id]);

  if (!block) {
    return <p className={formStyles.hint}>Select a block from the Blocks tab (its &quot;Manage&quot; action) to see its rooming list.</p>;
  }

  return (
    <div>
      <p className={formStyles.hint}>
        Reservations booked against <strong>{block.block_name}</strong>. Book a new one from the Booking screen&apos;s own form — pick this block there.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <DataTable
        title="Rooming list"
        state={reservations === null ? 'loading' : reservations.length === 0 ? 'empty' : 'success'}
        emptyMessage="No reservations booked against this block yet."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation #' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          { key: 'adults', label: 'Adults', align: 'right' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} label={row.status.replace('_', ' ')} /> },
        ]}
        rows={reservations ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
