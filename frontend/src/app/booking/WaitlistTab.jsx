import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './BookingForm.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.2: "Waitlist — separate queue view with
 * promote-to-confirmed action."
 *
 * Bug fix (user-reported "the waitlist seems not working" — live-tested the
 * real end-to-end flow first: create a waitlisted reservation, confirm it
 * lists here, promote it while still full (correctly rejected), free
 * inventory, promote again (correctly succeeds) — every one of those worked
 * against the real backend). The actual defect was here on the frontend:
 * the error banner lived inside DataTable's own `toolbar` slot, which
 * `Card` only renders while `state === 'success'` — and a real fetch/promote
 * failure both sets `error` AND leaves `entries` as `[]` (the catch
 * block's own fallback), which computes `state: 'empty'`. The two
 * conditions land at the exact same time, every time, so the error text
 * could never actually be seen — a genuine backend problem would have
 * silently rendered as the identical, misleading "No one is currently
 * waitlisted," exactly the "looks broken" symptom reported. This is the
 * same defect this codebase already found and fixed in five OTHER tabs
 * (`OccupancyTab`, `RevenueTab`, `BoardTab`, `DiscrepanciesTab`,
 * `ReservationsListTab`) — `WaitlistTab` was simply missed at the time.
 * Fixed the identical way: the error banner is now a plain sibling above
 * `DataTable`, not inside its state-gated `toolbar`.
 */
export function WaitlistTab() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [promotingId, setPromotingId] = useState(null);

  async function reload() {
    try {
      setEntries(await reservationsApi.listWaitlist());
    } catch (caught) {
      setEntries([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the waitlist.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handlePromote(id) {
    setPromotingId(id);
    setError(null);
    try {
      await reservationsApi.promoteWaitlist(id);
      await reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not promote this reservation — inventory may still be unavailable.'
      );
    } finally {
      setPromotingId(null);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <DataTable
        title="Waitlist"
        state={entries === null ? 'loading' : entries.length === 0 ? 'empty' : 'success'}
        emptyMessage="No one is currently waitlisted."
        columns={[
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'arrival_date', label: 'Arrival' },
          { key: 'departure_date', label: 'Departure' },
          { key: 'adults', label: 'Adults', align: 'right' },
        ]}
        rows={entries ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" loading={promotingId === row.id} onClick={() => handlePromote(row.id)}>
            Promote
          </Button>
        )}
        errorMessage={error}
      />
    </>
  );
}
