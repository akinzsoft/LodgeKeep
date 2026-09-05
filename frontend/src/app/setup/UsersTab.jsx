import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { usersApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * No `GET /roles` endpoint exists yet — `src/auth/roles.js`'s own header
 * names these as "the seven roles in SECURITY.md §5," seeded into every
 * tenant at provisioning, so this list is hardcoded here rather than
 * fetched. A tenant that ever renames or adds a custom role would need a
 * real roles-listing endpoint first; flagged, not silently assumed away.
 */
const ROLES = ['front_desk', 'cashier', 'housekeeping', 'pos_operator', 'manager', 'admin', 'super_admin'];

/**
 * UsersTab — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md §3.19's
 * "User management — list, create, assign role, deactivate (never delete).
 * Show last login so dormant accounts are visible."
 *
 * "Create" here is really "invite" (§3.16: "admin invites by email, invitee
 * sets their own password") — there is no form on this screen that sets a
 * password on someone else's behalf. Acceptance happens on a separate,
 * unauthenticated screen reached from the invitation link
 * (`AcceptInvitationScreen`, wired in `main.jsx` off a `?invite_token=` URL
 * parameter, since this app still has no router).
 */
export function UsersTab({ disabled, isOffline = false }) {
  const [users, setUsers] = useState(null);
  const [invitations, setInvitations] = useState(null);
  const [error, setError] = useState(null);

  const [inviteForm, setInviteForm] = useState({ email: '', role: 'front_desk' });
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);

  const [deactivating, setDeactivating] = useState(null);
  const [roleChangingId, setRoleChangingId] = useState(null);

  async function reload() {
    try {
      const [userRows, invitationRows] = await Promise.all([usersApi.listUsers(), usersApi.listPendingInvitations()]);
      setUsers(userRows);
      setInvitations(invitationRows);
    } catch (caught) {
      setUsers([]);
      setInvitations([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load users.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — user access is granted per property.</p>;
  }

  async function handleInvite(event) {
    event.preventDefault();
    setInviteSubmitting(true);
    setError(null);
    setInviteResult(null);
    try {
      const invitation = await usersApi.inviteUser({ email: inviteForm.email, role: inviteForm.role });
      setInviteResult(invitation);
      setInviteForm({ email: '', role: 'front_desk' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send the invitation.');
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function handleDeactivate() {
    try {
      await usersApi.deactivateUser(deactivating.id);
      setDeactivating(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not deactivate this user.');
      setDeactivating(null);
    }
  }

  async function handleRoleChange(row, role) {
    setRoleChangingId(row.id);
    setError(null);
    try {
      await usersApi.changeUserRole(row.id, role);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change this user’s role.');
    } finally {
      setRoleChangingId(null);
    }
  }

  return (
    <div className={styles.page}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <DataTable
        title="Users"
        state={users === null ? 'loading' : users.length === 0 ? 'empty' : 'success'}
        emptyMessage="No users at this property yet."
        columns={[
          { key: 'email', label: 'Email' },
          { key: 'name', label: 'Name', render: (row) => `${row.first_name} ${row.last_name}` },
          {
            key: 'role',
            label: 'Role',
            render: (row) => (
              <select
                className={formStyles.select}
                value={row.role}
                disabled={isOffline || roleChangingId === row.id || row.status === 'inactive'}
                onChange={(event) => handleRoleChange(row, event.target.value)}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            render: (row) => <StatusPill tone={row.status === 'active' ? 'success' : 'neutral'} label={row.status} />,
          },
          { key: 'last_login_at', label: 'Last login', render: (row) => row.last_login_at ?? 'Never' },
        ]}
        rows={users ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          row.status === 'active' && (
            <Button variant="danger" size="compact" disabled={isOffline} onClick={() => setDeactivating(row)}>
              Deactivate
            </Button>
          )
        }
      />

      <Card title="Invite a user">
        {inviteResult && (
          <p className={formStyles.disabledNotice} role="status">
            Invitation sent to {inviteResult.email}.
            {inviteResult.dev_only_token && (
              <>
                {' '}
                Dev-only token (never present in production): <code>{inviteResult.dev_only_token}</code>
              </>
            )}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleInvite}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Email</span>
              <input
                className={formStyles.input}
                type="email"
                value={inviteForm.email}
                onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
                placeholder="new.hire@example.com"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Role</span>
              <select
                className={formStyles.select}
                value={inviteForm.role}
                onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={inviteSubmitting} disabled={isOffline}>
              Send invitation
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Pending invitations"
        state={invitations === null ? 'loading' : invitations.length === 0 ? 'empty' : 'success'}
        emptyMessage="No outstanding invitations."
        columns={[
          { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role' },
          {
            key: 'status',
            label: 'Status',
            render: (row) => <StatusPill tone={row.status === 'pending' ? 'warning' : 'neutral'} label={row.status} />,
          },
          { key: 'expires_at', label: 'Expires' },
        ]}
        rows={invitations ?? []}
        rowKey={(row) => row.id}
      />

      {deactivating && (
        <ConfirmDialog
          title="Deactivate user"
          consequence={`This immediately revokes ${deactivating.email}'s sessions and access. Their record is kept for audit-trail history, and this can only be undone by inviting them again.`}
          confirmLabel="Confirm deactivation"
          onConfirm={handleDeactivate}
          onCancel={() => setDeactivating(null)}
        />
      )}
    </div>
  );
}
