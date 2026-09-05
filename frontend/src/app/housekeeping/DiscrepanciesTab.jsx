import { useEffect, useState } from 'react';
import { DataTable, StatusPill, Button, ConfirmDialog } from '../../shared/components/index.js';
import { housekeepingApi, ApiError } from '../../shared/api/index.js';
import formStyles from './HousekeepingForm.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.6: "Discrepancy report — dedicated view listing
 * rooms where front-desk status ≠ housekeeper-reported status ... each row
 * showing both values side by side and a resolve action. This must be a
 * first-class screen, not buried in a report dropdown."
 */
export function DiscrepanciesTab({ isOffline = false }) {
  const [filter, setFilter] = useState('open');
  const [discrepancies, setDiscrepancies] = useState(null);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(null);

  async function reload(currentFilter = filter) {
    try {
      const resolved = currentFilter === 'open' ? false : currentFilter === 'resolved' ? true : undefined;
      setDiscrepancies(await housekeepingApi.listDiscrepancies(resolved === undefined ? {} : { resolved }));
    } catch (caught) {
      setDiscrepancies([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load discrepancies.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is redefined every render and read here only for the mount-time fetch (filter is still its initial value at that point); listing it as a dep would re-run this effect on every render since it's a new function reference each time. Filter-change reloads already go through the select's onChange, which calls reload(event.target.value) explicitly.
  }, []);

  async function handleResolve(reason) {
    try {
      await housekeepingApi.resolveDiscrepancy(resolving.id, reason);
      setResolving(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not resolve this discrepancy.');
      setResolving(null);
    }
  }

  return (
    <>
      {/* Outside DataTable's own toolbar slot, deliberately: Card only
          renders `children` — toolbar included — while `state ===
          'success'`. "No open discrepancies" is the ordinary, desired
          state, not an edge case — a filter control that vanishes exactly
          then would be unreachable most of the time. */}
      <label className={formStyles.field}>
        <span className={formStyles.label}>Filter</span>
        <select
          className={formStyles.select}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            reload(event.target.value);
          }}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </label>
      <DataTable
        title="Discrepancies"
        state={discrepancies === null ? 'loading' : discrepancies.length === 0 ? 'empty' : 'success'}
        emptyMessage={filter === 'open' ? 'No open discrepancies right now.' : 'No discrepancies match this filter.'}
        columns={[
          { key: 'room_id', label: 'Room' },
          { key: 'business_date', label: 'Business date' },
          { key: 'front_desk_status', label: 'Front desk says' },
          { key: 'housekeeping_status', label: 'Housekeeping says' },
          {
            key: 'resolved_at',
            label: 'Status',
            render: (row) => (row.resolved_at ? <StatusPill tone="success" label="Resolved" /> : <StatusPill tone="danger" label="Open" />),
          },
        ]}
        rows={discrepancies ?? []}
        rowKey={(row) => row.id}
        errorMessage={error}
        actions={(row) =>
          !row.resolved_at && (
            <Button disabled={isOffline} onClick={() => setResolving(row)}>
              Resolve
            </Button>
          )
        }
      />

      {resolving && (
        <ConfirmDialog
          title="Resolve discrepancy"
          consequence={`This marks room ${resolving.room_id}'s discrepancy as resolved and clears it from sellable-inventory exclusion. This cannot be undone.`}
          requireReason
          confirmLabel="Confirm resolution"
          onConfirm={handleResolve}
          onCancel={() => setResolving(null)}
        />
      )}
    </>
  );
}
