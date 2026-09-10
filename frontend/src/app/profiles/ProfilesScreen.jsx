import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { profilesApi, reservationsApi, ApiError } from '../../shared/api/index.js';
import { CompanyProfilesTab } from './CompanyProfilesTab.jsx';
import styles from './ProfilesScreen.module.css';
import formStyles from './ProfilesForm.module.css';

const TABS = [
  { key: 'guests', label: 'Guests' },
  { key: 'companies', label: 'Companies' },
];

/**
 * ProfilesScreen — PLAN.md Phase 2 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.1/"Guest Profiles screens": "Profile list with search across
 * name/email/phone ... Profile detail: contact info ... stay history (past
 * + upcoming reservations)."
 *
 * VIP badge/tier and loyalty balance — also named in that same screen spec
 * — are still NOT shown here: neither exists yet (Phase 6, per PLAN.md).
 * Linked company/travel-agent profile and AR balance, however, are now real
 * (PLAN.md Phase 4, Accounts Receivable) — a "Companies" tab (new) owns
 * company-profile CRUD, and the guest detail panel below gets a "Linked
 * company" picker calling the new `POST /guests/:id/link-company`. AR
 * balance itself lives on the AR screen (`app/ar/`), not duplicated here —
 * this screen only shows which company a guest is linked to, not that
 * company's own balance (see `CompanyProfilesTab`'s own header for why).
 *
 * No router exists in this app — search-then-select is this screen's own
 * navigation, the same "start from a lookup" shape `CashieringScreen`
 * already established for reaching a specific record with no deep link to
 * hand it one.
 *
 * Gap closure (user-reported): "i shld be able to see all my guests and
 * export to pdf" — search used to be required (a `required` input, no
 * results shown until submitted); a real `GET /guests` already existed
 * (`reservationsApi.listGuests`, Phase 2's own guest stub, unrelated to
 * this module but the same `guests` table) and is now fetched on mount so
 * the full list is the default view, with search narrowing it. "Export to
 * PDF" is the browser's own print dialog (its own "Save as PDF"
 * destination is a real PDF, no new library — confirmed with the user
 * before building, since this codebase has never had one) — see this
 * file's own `.module.css` and `app/shell`'s `@media print` rules for the
 * two halves of that (hiding this screen's own toolbar; hiding the app
 * chrome around it).
 *
 * Gap closure (user-reported): "add summary report ... num of active and
 * inactive customer ... click to see active or inactive customers." A
 * plain two-stat summary — built directly here, not `KPICard` (that
 * component is documented as presentation-only, no click behaviour, and
 * used across the dashboard; bolting an `onClick` onto it for one screen
 * would stretch a shared component past its own contract for a single
 * caller) — with each stat doubling as a filter toggle
 * (`aria-pressed`), the third view alongside "all guests" and "search",
 * mutually exclusive with both (`filterMode`).
 */
export function ProfilesScreen({ isOffline = false } = {}) {
  const [tab, setTab] = useState('guests');
  const [allGuests, setAllGuests] = useState(null);
  const [allGuestsError, setAllGuestsError] = useState(null);
  const [activitySummary, setActivitySummary] = useState(null);
  const [activitySummaryError, setActivitySummaryError] = useState(null);
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState(null); // null | 'search' | 'active' | 'inactive'
  const [filteredGuests, setFilteredGuests] = useState(null);
  const [filterError, setFilterError] = useState(null);
  const [filtering, setFiltering] = useState(false);

  const [selectedGuest, setSelectedGuest] = useState(null);
  const [stayHistory, setStayHistory] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [companies, setCompanies] = useState(null);
  const [linkedCompanyId, setLinkedCompanyId] = useState('');
  const [linkingSubmitting, setLinkingSubmitting] = useState(false);
  const [linkingError, setLinkingError] = useState(null);

  useEffect(() => {
    reservationsApi
      .listGuests()
      .then(setAllGuests)
      .catch((caught) => {
        setAllGuests([]);
        setAllGuestsError(caught instanceof ApiError ? caught.message : 'Could not load guests.');
      });
    profilesApi
      .getGuestActivitySummary()
      .then(setActivitySummary)
      .catch((caught) => {
        setActivitySummary(null);
        setActivitySummaryError(caught instanceof ApiError ? caught.message : 'Could not load the guest activity summary.');
      });
  }, []);

  // `filteredGuests` is only ever set by a submitted search or an activity
  // click; while it's null, the full list (fetched on mount) is what's
  // shown — filtering narrows it, never the only way to see anyone.
  const displayedGuests = filteredGuests ?? allGuests;
  const isFiltered = filterMode !== null;

  async function handleSearch(event) {
    event.preventDefault();
    setFiltering(true);
    setFilterError(null);
    try {
      setFilteredGuests(await profilesApi.searchGuests(query));
      setFilterMode('search');
    } catch (caught) {
      setFilteredGuests([]);
      setFilterMode('search');
      setFilterError(caught instanceof ApiError ? caught.message : 'Could not search guests.');
    } finally {
      setFiltering(false);
    }
  }

  async function handleFilterByActivity(activity) {
    setFiltering(true);
    setFilterError(null);
    setQuery('');
    try {
      setFilteredGuests(await reservationsApi.listGuests({ activity }));
      setFilterMode(activity);
    } catch (caught) {
      setFilteredGuests([]);
      setFilterMode(activity);
      setFilterError(caught instanceof ApiError ? caught.message : 'Could not load guests by activity.');
    } finally {
      setFiltering(false);
    }
  }

  function handleClearFilter() {
    setQuery('');
    setFilteredGuests(null);
    setFilterMode(null);
    setFilterError(null);
  }

  async function handleSelect(guest) {
    setSelectedGuest(guest);
    setStayHistory(null);
    setDetailError(null);
    setLinkedCompanyId(guest.company_profile_id != null ? String(guest.company_profile_id) : '');
    setLinkingError(null);
    try {
      setStayHistory(await profilesApi.getGuestStayHistory(guest.id));
    } catch (caught) {
      setStayHistory([]);
      setDetailError(caught instanceof ApiError ? caught.message : 'Could not load stay history.');
    }
    if (companies === null) {
      try {
        setCompanies(await profilesApi.listCompanyProfiles());
      } catch {
        setCompanies([]);
      }
    }
  }

  /** PLAN.md Phase 4 (Accounts Receivable) — links (or unlinks, an empty selection) this guest's company/travel-agent profile. */
  async function handleSaveLinkedCompany(event) {
    event.preventDefault();
    setLinkingSubmitting(true);
    setLinkingError(null);
    try {
      const updated = await reservationsApi.linkGuestToCompany(selectedGuest.id, linkedCompanyId || null);
      setSelectedGuest(updated);
    } catch (caught) {
      setLinkingError(caught instanceof ApiError ? caught.message : 'Could not update this guest’s linked company.');
    } finally {
      setLinkingSubmitting(false);
    }
  }

  const tableTitle =
    filterMode === 'search' ? 'Search results' : filterMode === 'active' ? 'Active guests' : filterMode === 'inactive' ? 'Inactive guests' : 'All guests';
  const emptyMessage =
    filterMode === 'search'
      ? 'No guests match this search.'
      : filterMode === 'active'
        ? 'No active guests — nobody has a reservation arriving in the last 12 months.'
        : filterMode === 'inactive'
          ? 'No inactive guests — everyone has a reservation arriving in the last 12 months.'
          : 'No guests on file yet.';

  return (
    <div className={styles.page}>
      <div className={styles.noPrint}>
        <h1 className={styles.title}>Profiles</h1>

        <div className={styles.tabs} role="tablist" aria-label="Profiles sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`.trim()}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'companies' && (
        <div className={styles.panel}>
          <CompanyProfilesTab isOffline={isOffline} />
        </div>
      )}

      {tab === 'guests' && (
        <>
      <div className={styles.noPrint}>
        <Card title="Guest activity">
          {activitySummaryError && (
            <p role="alert" className={formStyles.errorBanner}>
              {activitySummaryError}
            </p>
          )}
          {activitySummary && (
            <p className={formStyles.disabledNotice}>
              &ldquo;Active&rdquo; means a reservation arriving in the last 12 months.
            </p>
          )}
          <div className={styles.summaryRow}>
            <button
              type="button"
              className={styles.summaryStat}
              aria-pressed={filterMode === 'active'}
              aria-label="Active guests"
              disabled={!activitySummary}
              onClick={() => handleFilterByActivity('active')}
            >
              <span className={`${styles.summaryValue} tabular-nums`}>{activitySummary ? activitySummary.active : '—'}</span>
              <span className={styles.summaryLabel}>Active</span>
            </button>
            <button
              type="button"
              className={styles.summaryStat}
              aria-pressed={filterMode === 'inactive'}
              aria-label="Inactive guests"
              disabled={!activitySummary}
              onClick={() => handleFilterByActivity('inactive')}
            >
              <span className={`${styles.summaryValue} tabular-nums`}>{activitySummary ? activitySummary.inactive : '—'}</span>
              <span className={styles.summaryLabel}>Inactive</span>
            </button>
          </div>
        </Card>

        <Card title="Find a guest">
          {filterError && (
            <p role="alert" className={formStyles.errorBanner}>
              {filterError}
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
              <Button type="submit" loading={filtering}>
                Search
              </Button>
              {isFiltered && (
                <Button type="button" variant="ghost" onClick={handleClearFilter}>
                  Show all guests
                </Button>
              )}
            </div>
          </form>
        </Card>
      </div>

      {/* Gap closure: shown only in the printed/PDF output — the app
          chrome and business date aren't visible there once Sidebar/TopBar
          hide themselves, so the exported document needs its own label. */}
      <div className={styles.printOnly}>
        <h1>Guest List — {tableTitle}</h1>
        <p>Printed {new Date().toLocaleString()}</p>
      </div>

      {allGuestsError && !isFiltered && (
        <p role="alert" className={`${formStyles.errorBanner} ${styles.noPrint}`.trim()}>
          {allGuestsError}
        </p>
      )}

      <DataTable
        title={tableTitle}
        state={displayedGuests === null ? 'loading' : displayedGuests.length === 0 ? 'empty' : 'success'}
        emptyMessage={emptyMessage}
        columns={[
          { key: 'first_name', label: 'Name', render: (row) => `${row.first_name} ${row.last_name}` },
          { key: 'email', label: 'Email', render: (row) => row.email ?? '—' },
          { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
        ]}
        rows={displayedGuests ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <span className={styles.noPrint}>
            <Button size="compact" variant="secondary" onClick={() => handleSelect(row)}>
              View profile
            </Button>
          </span>
        )}
      />

      {displayedGuests && displayedGuests.length > 0 && (
        <div className={`${formStyles.actionsRow} ${styles.noPrint}`.trim()}>
          <Button variant="secondary" onClick={() => window.print()}>
            Export to PDF
          </Button>
        </div>
      )}

      {selectedGuest && (
        <div className={`${styles.detailRow} ${styles.noPrint}`.trim()}>
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

            {/* PLAN.md Phase 4 (Accounts Receivable) — PRODUCT_REQUIREMENTS.md's
                own profile-detail spec: "linked company/travel-agent profile."
                A plain picker, not a search-as-you-type — the company list is
                already loaded (fetched once, on first guest selection). */}
            {linkingError && (
              <p role="alert" className={formStyles.errorBanner}>
                {linkingError}
              </p>
            )}
            <form className={formStyles.row} onSubmit={handleSaveLinkedCompany}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Linked company</span>
                <select
                  className={formStyles.select}
                  value={linkedCompanyId}
                  disabled={isOffline || companies === null}
                  onChange={(event) => setLinkedCompanyId(event.target.value)}
                >
                  <option value="">No company linked</option>
                  {(companies ?? []).map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" size="compact" loading={linkingSubmitting} disabled={isOffline}>
                  Save
                </Button>
              </div>
            </form>
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
        </>
      )}
    </div>
  );
}
