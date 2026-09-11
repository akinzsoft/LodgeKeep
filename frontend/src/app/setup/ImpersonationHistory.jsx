import { useEffect, useState } from 'react';
import { DataTable } from '../../shared/components/index.js';
import { listOwnImpersonationSessions } from '../../shared/api/platform.js';
import { ApiError } from '../../shared/api/ApiError.js';

/**
 * ImpersonationHistory — SECURITY.md §2: "Planmsys support staff needing to
 * view a customer's data use an explicit, time-bounded impersonation path
 * that is logged, visible to the tenant, and never a silent super-admin
 * flag." This is that visibility, on the tenant's own side — the
 * counterpart to `TenantDetailScreen`'s identical table on the platform
 * console side, reading the same rows through a different, staff-gated
 * endpoint (`GET /impersonation-sessions`, `setup.view`).
 *
 * Read-only, deliberately: a tenant admin can see who from platform support
 * looked at their account, when, why, and for how long, but has no action
 * to take here — only platform staff (or the grant's own token) can end a
 * session, and a session is time-bounded regardless.
 *
 * Not gated on an active property existing (unlike this screen's other
 * tabs) — a tenant's support-access history spans every property and every
 * platform admin who has ever used it, not one property's own setup state.
 */
export function ImpersonationHistory() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setSessions(await listOwnImpersonationSessions());
      } catch (caught) {
        setSessions([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load support-access history.');
      }
    })();
  }, []);

  return (
    <DataTable
      title="Support access history"
      state={sessions === null ? 'loading' : error ? 'error' : 'success'}
      errorMessage={error}
      emptyMessage="No platform support staff has accessed this account."
      rows={sessions ?? []}
      rowKey={(row) => row.id}
      columns={[
        { key: 'platform_user', label: 'Platform staff', render: (row) => row.platform_user?.email ?? 'Unknown' },
        { key: 'property_id', label: 'Property', render: (row) => String(row.property_id) },
        { key: 'reason', label: 'Reason' },
        { key: 'started_at', label: 'Started' },
        { key: 'ended_at', label: 'Ended', render: (row) => row.ended_at ?? 'Still active / lapsed' },
      ]}
    />
  );
}
