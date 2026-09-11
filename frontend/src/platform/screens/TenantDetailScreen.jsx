import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

const STATUS_TONE = { trial: 'warning', active: 'success', suspended: 'danger', offboarding: 'neutral' };

/**
 * TenantDetailScreen — PLAN.md Phase 5 (Platform Foundation). Tenant
 * metadata, its properties, its real impersonation history (SECURITY.md
 * §2's "visible to the tenant" — the platform side of the same record),
 * and the "Impersonate" action itself: a property picker plus a REQUIRED
 * reason field, the same "money confirmations require a reason" discipline
 * this codebase already applies to a credit-limit override or a void,
 * applied here to an equally consequential action.
 */
export function TenantDetailScreen({ tenantId, onBack, onLogout }) {
  const { startImpersonation, error: impersonationError, role } = usePlatformAuth();
  const [tenant, setTenant] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);

  const [propertyId, setPropertyId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [lifecycleReason, setLifecycleReason] = useState('');
  const [lifecycleSubmitting, setLifecycleSubmitting] = useState(false);
  const [lifecycleError, setLifecycleError] = useState(null);

  async function reload() {
    setError(null);
    try {
      const [tenantRow, sessionRows] = await Promise.all([
        platformApi.getTenant(tenantId),
        platformApi.listImpersonationSessionsForTenant(tenantId),
      ]);
      setTenant(tenantRow);
      setSessions(sessionRows);
      if (tenantRow.properties?.length === 1) setPropertyId(String(tenantRow.properties[0].id));
    } catch (caught) {
      setTenant(null);
      setSessions([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load this tenant.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, [tenantId]);

  async function handleImpersonate(event) {
    event.preventDefault();
    setSubmitting(true);
    await startImpersonation(tenantId, { propertyId, reason, tenantName: tenant?.name });
    setSubmitting(false);
  }

  async function handleSuspend(event) {
    event.preventDefault();
    setLifecycleError(null);
    setLifecycleSubmitting(true);
    try {
      await platformApi.suspendTenant(tenantId, lifecycleReason);
      setLifecycleReason('');
      await reload();
    } catch (caught) {
      setLifecycleError(caught instanceof ApiError ? caught.message : 'Could not suspend this tenant.');
    } finally {
      setLifecycleSubmitting(false);
    }
  }

  async function handleReactivate(event) {
    event.preventDefault();
    setLifecycleError(null);
    setLifecycleSubmitting(true);
    try {
      await platformApi.reactivateTenant(tenantId, lifecycleReason);
      setLifecycleReason('');
      await reload();
    } catch (caught) {
      setLifecycleError(caught instanceof ApiError ? caught.message : 'Could not reactivate this tenant.');
    } finally {
      setLifecycleSubmitting(false);
    }
  }

  return (
    <div className={styles.console}>
      <div className={styles.consoleHeader}>
        <h1 className={styles.consoleTitle}>{tenant?.name ?? 'Tenant'}</h1>
        {tenant?.status && <StatusPill tone={STATUS_TONE[tenant.status] ?? 'neutral'} label={tenant.status} />}
        <Button variant="ghost" onClick={onLogout}>
          Sign out
        </Button>
      </div>
      <button type="button" className={styles.backLink} onClick={onBack}>
        &larr; Back to tenants
      </button>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}

      {tenant && (
        <Card title="Tenant lifecycle">
          {lifecycleError && (
            <p role="alert" className={styles.errorBanner}>
              {lifecycleError}
            </p>
          )}
          <p className={styles.hint}>
            Trial and suspended tenants remain fully readable — every write is blocked until reactivated
            (PRODUCT_REQUIREMENTS.md §3.22).{' '}
            {role !== 'admin' && "Suspend/reactivate require the platform admin tier — your account can still try, but the server will refuse it."}
          </p>
          {(tenant.status === 'trial' || tenant.status === 'active') && (
            <form className={styles.form} onSubmit={handleSuspend}>
              <label className={styles.field}>
                <span className={styles.label}>Reason (required, recorded on the audit trail)</span>
                <input
                  className={styles.input}
                  value={lifecycleReason}
                  onChange={(event) => setLifecycleReason(event.target.value)}
                  required
                  placeholder="e.g. Payment failed"
                />
              </label>
              <Button type="submit" variant="danger" loading={lifecycleSubmitting}>
                Suspend tenant
              </Button>
            </form>
          )}
          {tenant.status === 'suspended' && (
            <form className={styles.form} onSubmit={handleReactivate}>
              <label className={styles.field}>
                <span className={styles.label}>Reason (optional)</span>
                <input
                  className={styles.input}
                  value={lifecycleReason}
                  onChange={(event) => setLifecycleReason(event.target.value)}
                  placeholder="e.g. Payment received"
                />
              </label>
              <Button type="submit" loading={lifecycleSubmitting}>
                Reactivate tenant
              </Button>
            </form>
          )}
          {tenant.status === 'offboarding' && <p className={styles.hint}>This tenant is offboarding — no lifecycle transition is available yet.</p>}
        </Card>
      )}

      <DataTable
        title="Properties"
        state={tenant === null ? 'loading' : (tenant.properties ?? []).length === 0 ? 'empty' : 'success'}
        emptyMessage="This tenant has no properties yet."
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'slug', label: 'Slug' },
          { key: 'status', label: 'Status' },
        ]}
        rows={tenant?.properties ?? []}
        rowKey={(row) => row.id}
      />

      {tenant && (
        <Card title="Impersonate this tenant, read-only">
          {impersonationError && (
            <p role="alert" className={styles.errorBanner}>
              {impersonationError}
            </p>
          )}
          <p className={styles.hint}>
            View this tenant&apos;s own staff-app screens and data, read-only, for a time-bounded support session. Starting
            and ending this session is recorded and shown to the tenant below (SECURITY.md §2); read-only access is
            enforced by the server for the whole session, but individual reads are not separately logged.
          </p>
          <form className={styles.form} onSubmit={handleImpersonate}>
            <label className={styles.field}>
              <span className={styles.label}>Property</span>
              <select className={styles.select} value={propertyId} onChange={(event) => setPropertyId(event.target.value)} required>
                <option value="" disabled>
                  Select a property
                </option>
                {(tenant.properties ?? []).map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Reason (required, visible to the tenant)</span>
              <input className={styles.input} value={reason} onChange={(event) => setReason(event.target.value)} required placeholder="e.g. Support ticket #1234" />
            </label>
            <Button type="submit" loading={submitting}>
              Start impersonation
            </Button>
          </form>
        </Card>
      )}

      <DataTable
        title="Impersonation history"
        state={sessions === null ? 'loading' : sessions.length === 0 ? 'empty' : 'success'}
        emptyMessage="No platform staff has ever viewed this tenant's account."
        columns={[
          { key: 'platform_user', label: 'Platform staff', render: (row) => row.platform_user?.email ?? '—' },
          { key: 'reason', label: 'Reason' },
          { key: 'started_at', label: 'Started' },
          { key: 'ended_at', label: 'Ended', render: (row) => row.ended_at ?? 'In progress / lapsed' },
        ]}
        rows={sessions ?? []}
        rowKey={(row) => row.id}
      />
    </div>
  );
}
