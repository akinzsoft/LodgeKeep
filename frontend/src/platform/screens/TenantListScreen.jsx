import { useEffect, useState } from 'react';
import { DataTable, StatusPill, Button } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import styles from './PlatformScreens.module.css';

const STATUS_TONE = { trial: 'warning', active: 'success', suspended: 'danger', offboarding: 'neutral' };

/** TenantListScreen — PLAN.md Phase 5 (Platform Foundation), PRODUCT_REQUIREMENTS.md §3.22's "tenant list, plan and status." No impersonation grant required — this is the platform's own account roster. */
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
