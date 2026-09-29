import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { usersApi, posApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';
import { EmailDeliveryNotice } from './EmailDeliveryNotice.jsx';

/**
 * No `GET /roles` endpoint exists yet — `src/auth/roles.js`'s own header
 * names these as "the system roles in SECURITY.md §5," seeded into every
 * tenant at provisioning, so this list is hardcoded here rather than
 * fetched. A tenant that ever renames or adds a custom role would need a
 * real roles-listing endpoint first; flagged, not silently assumed away.
 */
const ROLES = ['front_desk', 'cashier', 'housekeeping', 'pos_operator', 'storekeeper', 'manager', 'admin', 'super_admin'];

/**
 * Roles an outlet assignment never limits (`backend/src/shared/outlet-assignments.js`),
 * so the Outlets action is not offered for them.
 */
const ROLES_ALL_OUTLETS = ['manager', 'admin', 'super_admin'];

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

  // Staff outlet assignments (user-requested: tie staff to outlets) — which
  // outlets a POS operator or storekeeper works at, for the Register, shifts,
  // stock requests and their alerts. None ticked = every outlet.
  const [outlets, setOutlets] = useState(null);
  const [editingOutlets, setEditingOutlets] = useState(null); // {user, chosen: Set}

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

  useEffect(() => {
    if (disabled) return;
    // A role that cannot read outlets simply gets no Outlets column; the rest of the screen still works.
    posApi.listOutlets().then(setOutlets, () => setOutlets([]));
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

  function outletNames(row) {
    if (ROLES_ALL_OUTLETS.includes(row.role)) return 'All outlets (role)';
    if (!row.outlet_ids?.length) return 'All outlets';
    const byId = new Map((outlets ?? []).map((outlet) => [String(outlet.id), outlet.name]));
    return row.outlet_ids.map((id) => byId.get(String(id)) ?? `Outlet ${id}`).join(', ');
  }

  async function handleSaveOutlets() {
    const { user, chosen } = editingOutlets;
    setError(null);
    try {
      await usersApi.setUserOutlets(user.id, [...chosen]);
      setEditingOutlets(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this user’s outlets.');
      setEditingOutlets(null);
    }
  }

  function toggleOutlet(outletId) {
    setEditingOutlets((current) => {
      const chosen = new Set(current.chosen);
      if (chosen.has(outletId)) chosen.delete(outletId);
      else chosen.add(outletId);
      return { ...current, chosen };
    });
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
          ...(outlets && outlets.length ? [{ key: 'outlets', label: 'Outlets', render: outletNames }] : []),
          { key: 'last_login_at', label: 'Last login', render: (row) => row.last_login_at ?? 'Never' },
        ]}
        rows={users ?? []}
        rowKey={(row) => row.id}
        actions={(row) =>
          row.status === 'active' && (
            <>
              {outlets && outlets.length > 0 && !ROLES_ALL_OUTLETS.includes(row.role) && (
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={isOffline}
                  onClick={() => setEditingOutlets({ user: row, chosen: new Set((row.outlet_ids ?? []).map(String)) })}
                  aria-label={`Outlets for ${row.email}`}
                >
                  Outlets
                </Button>
              )}
              <Button variant="danger" size="compact" disabled={isOffline} onClick={() => setDeactivating(row)}>
                Deactivate
              </Button>
            </>
          )
        }
      />

      <Card title="Invite a user">
        <EmailDeliveryNotice where="invite" />
        {inviteResult && inviteResult.email_delivery?.sendsEmail === false && (
          <p className={formStyles.warningBanner} role="alert">
            Invitation created for {inviteResult.email}, but no email was sent: this property has no mailbox set up. Set one up
            in Setup → Email settings, then invite them again.
          </p>
        )}
        {inviteResult && (inviteResult.email_delivery?.sendsEmail !== false || inviteResult.dev_only_token) && (
          <p className={formStyles.disabledNotice} role="status">
            {inviteResult.email_delivery?.sendsEmail !== false && <>Invitation sent to {inviteResult.email}. </>}
            {inviteResult.dev_only_token && (
              <>
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

      {editingOutlets && (
        <ConfirmDialog
          title={`Outlets for ${editingOutlets.user.email}`}
          consequence={
            editingOutlets.chosen.size
              ? 'They will only be able to sell and run shifts at these outlets on the Register, request stock for them, see requests to or from them, and get stock alerts about them.'
              : 'No outlet ticked: they cover every outlet (the default).'
          }
          confirmLabel="Save outlets"
          onConfirm={handleSaveOutlets}
          onCancel={() => setEditingOutlets(null)}
        >
          <fieldset className={formStyles.form}>
            <legend className={formStyles.label}>Works at</legend>
            {(outlets ?? []).map((outlet) => (
              <label key={outlet.id} className={formStyles.checkboxField}>
                <input
                  type="checkbox"
                  checked={editingOutlets.chosen.has(String(outlet.id))}
                  onChange={() => toggleOutlet(String(outlet.id))}
                />
                <span>
                  {outlet.name}
                  {outlet.type === 'store' ? ' (store)' : ''}
                </span>
              </label>
            ))}
          </fieldset>
        </ConfirmDialog>
      )}

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
