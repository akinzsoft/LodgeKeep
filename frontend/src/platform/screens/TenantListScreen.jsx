import { useEffect, useState } from 'react';
import { DataTable, StatusPill, Button } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import styles from './PlatformScreens.module.css';

const STATUS_TONE = { trial: 'warning', active: 'success', suspended: 'danger', offboarding: 'neutral' };

/** DESIGN_SYSTEM.md §1: status is always a filled pill with a text label, never colour alone — the same vocabulary `BillingScreen.jsx` owns for the tenant's own billing screen, duplicated here rather than imported (this is a different, broader-audience surface). */
const SUBSCRIPTION_STATUS_TONE = { active: 'success', past_due: 'warning', canceled: 'neutral' };

/** PRODUCT_REQUIREMENTS.md §3.22's "Tenant list — ... signup date, last activity." Raw facts, never reformatted — matching this screen family's own established convention of rendering a stored timestamp as-is. */
function describeTrial(row) {
  if (row.status !== 'trial') return '—';
  if (row.trial_days_remaining === null) return 'No expiry set';
  if (row.trial_days_remaining < 0) return `Expired ${Math.abs(row.trial_days_remaining)}d ago`;
  return `${row.trial_days_remaining}d left`;
}

/** TenantListScreen — PLAN.md Phase 5 (Platform Foundation), PRODUCT_REQUIREMENTS.md §3.22's "tenant list, plan and status." No impersonation grant required — this is the platform's own account roster.
 *
 * PLAN.md Phase 5's own "tenant list, health" bullet: the plan/property-count/trial/subscription/signup/last-login
 * columns below are all raw facts the backend already resolves (`platform/service.js`'s `attachTenantHealth`) —
 * deliberately no computed "at risk" badge, and no room count (only property count — reaching `rooms`, a
 * PROPERTY_SCOPED operational table, would cut against this console's own "never a back door into tenant data" rule).
 */
export function TenantListScreen({ onSelectTenant, onLogout }) {
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState(null);

  async function reload() {
    setError(null);
    try {
      setTenants(await platformApi.listTenants());
    } catch (caught) {
      setTenants([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load tenants.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  return (
    <div className={styles.console}>
      <div className={styles.consoleHeader}>
        <h1 className={styles.consoleTitle}>Tenants</h1>
        <Button variant="ghost" onClick={onLogout}>
          Sign out
        </Button>
      </div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      <DataTable
        title="All tenants"
        state={tenants === null ? 'loading' : tenants.length === 0 ? 'empty' : 'success'}
        emptyMessage="No tenants exist yet."
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'slug', label: 'Slug' },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} label={row.status} /> },
          { key: 'plan', label: 'Plan', render: (row) => row.plan?.name ?? 'No plan' },
          { key: 'property_count', label: 'Properties', render: (row) => row.property_count },
          { key: 'trial', label: 'Trial', render: describeTrial },
          {
            key: 'subscription_status',
            label: 'Subscription',
            render: (row) =>
              row.subscription_status ? (
                <StatusPill tone={SUBSCRIPTION_STATUS_TONE[row.subscription_status] ?? 'neutral'} label={row.subscription_status} />
              ) : (
                <StatusPill tone="neutral" label="No subscription" />
              ),
          },
          { key: 'created_at', label: 'Signed up', render: (row) => row.created_at },
          { key: 'last_login_at', label: 'Last login', render: (row) => row.last_login_at ?? 'Never' },
        ]}
        rows={tenants ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="secondary" onClick={() => onSelectTenant(row.id)}>
            View
          </Button>
        )}
      />
    </div>
  );
}
