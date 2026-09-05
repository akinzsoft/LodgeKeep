import { useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { profilesApi, ApiError } from '../../shared/api/index.js';
import styles from './ProfilesScreen.module.css';
import formStyles from './ProfilesForm.module.css';

/**
 * ProfilesScreen — PLAN.md Phase 2 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.1/"Guest Profiles screens": "Profile list with search across
 * name/email/phone ... Profile detail: contact info ... stay history (past
 * + upcoming reservations)."
 *
 * VIP badge/tier, loyalty balance, and linked company/travel-agent profile
 * — all named in that same screen spec — are NOT shown here: none of VIP
 * flags, loyalty accounts, or company profiles exist yet (Phase 6 and
 * Phase 4 respectively, per PLAN.md). AR balance is the same story (Phase
 * 4). This screen shows exactly what this pass built: contact info and
 * real stay history, nothing invented for the rest.
 *
 * No router exists in this app — search-then-select is this screen's own
 * navigation, the same "start from a lookup" shape `CashieringScreen`
 * already established for reaching a specific record with no deep link to
 * hand it one.
 */
export function ProfilesScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [searching, setSearching] = useState(false);

  const [selectedGuest, setSelectedGuest] = useState(null);
  const [stayHistory, setStayHistory] = useState(null);
  const [detailError, setDetailError] = useState(null);

  async function handleSearch(event) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await profilesApi.searchGuests(query));
    } catch (caught) {
      setResults([]);
      setSearchError(caught instanceof ApiError ? caught.message : 'Could not search guests.');
    } finally {
      setSearching(false);
    }
  }

  async function handleSelect(guest) {
    setSelectedGuest(guest);
    setStayHistory(null);
    setDetailError(null);
    try {
      setStayHistory(await profilesApi.getGuestStayHistory(guest.id));
    } catch (caught) {
      setStayHistory([]);
      setDetailError(caught instanceof ApiError ? caught.message : 'Could not load stay history.');
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Profiles</h1>

      <Card title="Find a guest">
        {searchError && (
          <p role="alert" className={formStyles.errorBanner}>
            {searchError}
          </p>
        )}
        <form className={formStyles.row} onSubmit={handleSearch}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Name, email, or phone</span>
            <input
              className={formStyles.input}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Jordan, or jordan@example.com"
              required
            />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={searching}>
              Search
            </Button>
          </div>
        </form>
      </Card>

      {results !== null && (
        <DataTable
          title="Results"
          state={results.length === 0 ? 'empty' : 'success'}
          emptyMessage="No guests match this search."
          columns={[
            { key: 'first_name', label: 'Name', render: (row) => `${row.first_name} ${row.last_name}` },
            { key: 'email', label: 'Email', render: (row) => row.email ?? '—' },
            { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
          ]}
          rows={results}
          rowKey={(row) => row.id}
          actions={(row) => (
            <Button size="compact" variant="secondary" onClick={() => handleSelect(row)}>
              View profile
            </Button>
          )}
        />
      )}

      {selectedGuest && (
        <div className={styles.detailRow}>
          <Card title="Guest details">
            <dl>
              <dt>Name</dt>
              <dd>
                {selectedGuest.first_name} {selectedGuest.last_name}
              </dd>
              <dt>Email</dt>
              <dd>{selectedGuest.email ?? '—'}</dd>
              <dt>Phone</dt>
              <dd>{selectedGuest.phone ?? '—'}</dd>
            </dl>
          </Card>

          {detailError && (
            <p role="alert" className={formStyles.errorBanner}>
              {detailError}
            </p>
          )}

          <DataTable
            title="Stay history"
            state={stayHistory === null ? 'loading' : stayHistory.length === 0 ? 'empty' : 'success'}
            emptyMessage="No reservations on record for this guest."
            columns={[
              { key: 'confirmation_number', label: 'Confirmation #' },
              { key: 'arrival_date', label: 'Arrival' },
              { key: 'departure_date', label: 'Departure' },
              { key: 'status', label: 'Status', render: (row) => <StatusPill tone="info" label={row.status} /> },
            ]}
            rows={stayHistory ?? []}
            rowKey={(row) => row.id}
          />
        </div>
      )}
    </div>
  );
}
