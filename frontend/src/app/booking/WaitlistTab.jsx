import { useEffect, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { reservationsApi, ApiError } from '../../shared/api/index.js';

/** PRODUCT_REQUIREMENTS.md §3.2: "Waitlist — separate queue view with promote-to-confirmed action." */
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
  );
}
