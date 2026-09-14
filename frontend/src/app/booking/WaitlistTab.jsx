import { useEffect, useState } from 'react';
import { DataTable, Button, ConfirmDialog, StatusPill } from '../../shared/components/index.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './BookingForm.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.2: "Waitlist — separate queue view with
 * promote-to-confirmed action."
 *
 * The queue, oldest request first (the backend orders by `created_at`):
 * who is waiting, for which room type, since when. Promote acquires real
 * inventory; Cancel removes a guest from the queue (a waitlisted reservation
 * holds no inventory, so nothing is released). Both are disabled while
 * offline (DESIGN_SYSTEM.md §2), matching every sibling tab's mutating
 * actions.
 *
 * A row whose arrival date is already before the property's business date
 * (`arrival_passed`, computed server-side) can never be promoted — the
 * backend refuses it — so Promote is disabled and an "Arrival passed" pill
 * tells staff to cancel it instead.
 *
 * Errors: a failed LOAD renders the table's own error state (never the
 * empty "No one is currently waitlisted." beside a real failure); a failed
 * promote/cancel shows a banner above the table, a plain sibling rather
 * than DataTable's `toolbar`, which Card only renders in the success state.
 */
export function WaitlistTab({ isOffline = false } = {}) {
  const [entries, setEntries] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [promotingId, setPromotingId] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  async function reload() {
    try {
      setEntries(await reservationsApi.listWaitlist());
      setLoadError(null);
    } catch (caught) {
      setEntries([]);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the waitlist.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handlePromote(id) {
    setPromotingId(id);
    setActionError(null);
    try {
      await reservationsApi.promoteWaitlist(id);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not promote this reservation. Please try again.');
    } finally {
      setPromotingId(null);
    }
  }

  async function handleCancel(reason) {
    setActionError(null);
    try {
      await reservationsApi.cancelReservation(cancelling.id, reason);
      setCancelling(null);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not cancel this reservation.');
      setCancelling(null);
    }
  }

  const state = entries === null ? 'loading' : loadError ? 'error' : entries.length === 0 ? 'empty' : 'success';

  return (
    <>
      {actionError && (
        <p role="alert" className={formStyles.errorBanner}>
          {actionError}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You&rsquo;re offline — promoting and cancelling are disabled until the connection returns.</p>}
      <DataTable
        title="Waitlist"
        state={state}
        emptyMessage="No one is currently waitlisted."
        errorMessage={loadError}
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'guest', label: 'Guest', render: (row) => [row.guest_first_name, row.guest_last_name].filter(Boolean).join(' ') || '—' },
          { key: 'guest_phone', label: 'Phone', render: (row) => row.guest_phone || '—' },
          { key: 'room_type', label: 'Room type', render: (row) => row.room_type_name || row.room_type_code || '—' },
          {
            key: 'arrival_date',
            label: 'Arrival',
            render: (row) => (
              <>
                {row.arrival_date}
                {row.arrival_passed && (
                  <>
                    {' '}
                    <StatusPill tone="warning" label="Arrival passed" />
                  </>
                )}
              </>
            ),
          },
          { key: 'departure_date', label: 'Departure' },
          { key: 'adults', label: 'Adults', align: 'right' },
          { key: 'created_at', label: 'Waiting since', render: (row) => formatWaitingSince(row.created_at) },
        ]}
        rows={entries ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button
              size="compact"
              loading={promotingId === row.id}
              disabled={isOffline || row.arrival_passed}
              onClick={() => handlePromote(row.id)}
            >
              Promote
            </Button>
            <Button variant="danger" size="compact" disabled={isOffline} onClick={() => setCancelling(row)}>
              Cancel
            </Button>
          </>
        )}
      />

      {cancelling && (
        <ConfirmDialog
          title="Remove from waitlist"
          consequence={`This cancels waitlisted reservation ${cancelling.confirmation_number}. It holds no room, so nothing is released. This cannot be undone.`}
          requireReason
          confirmLabel="Confirm cancellation"
          onConfirm={handleCancel}
          onCancel={() => setCancelling(null)}
        />
      )}
    </>
  );
}

function formatWaitingSince(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
