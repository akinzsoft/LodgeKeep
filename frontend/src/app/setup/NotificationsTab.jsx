import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Toast } from '../../shared/components/index.js';
import { notificationsApi, ApiError } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';
import styles from './NotificationsTab.module.css';

/** SECURITY.md §5's seven system roles, in the order Setup > Users lists them. */
const ROLES = [
  { code: 'front_desk', label: 'Front desk' },
  { code: 'cashier', label: 'Cashier' },
  { code: 'housekeeping', label: 'Housekeeping' },
  { code: 'pos_operator', label: 'POS operator' },
  { code: 'manager', label: 'Manager' },
  { code: 'admin', label: 'Admin' },
  { code: 'super_admin', label: 'Super admin' },
];

function cellKey(eventType, role) {
  return `${eventType}|${role}`;
}

/** Defaults from the catalogue with this property's saved overrides on top. */
function effectiveGrid(catalogue, rules) {
  const grid = {};
  for (const event of catalogue) {
    for (const { code } of ROLES) grid[cellKey(event.eventType, code)] = event.defaultRoles.includes(code);
  }
  for (const rule of rules) {
    const key = cellKey(rule.eventType, rule.role);
    if (key in grid) grid[key] = Boolean(rule.enabled);
  }
  return grid;
}

function defaultGrid(catalogue) {
  return effectiveGrid(catalogue, []);
}

/**
 * NotificationsTab — gap closure (user-reported: "add in setup to set user
 * that can get that notifications and the kind of notifications").
 * Confirmed with the user: recipients are chosen BY ROLE, per property — a
 * grid of notification types × roles — so new staff get the right alerts
 * from their role automatically.
 *
 * The notification types, labels, and default roles come from
 * `GET /notifications/catalogue`, never a second copy here. Managers can
 * read the grid (`notifications.view`); saving needs `notifications.manage`
 * (admin/super admin). No client-side role check hides Save — a manager gets
 * the real backend 403, the same convention as every other Setup tab.
 */
export function NotificationsTab({ disabled, isOffline = false }) {
  const [catalogue, setCatalogue] = useState(null);
  const [savedGrid, setSavedGrid] = useState(null);
  const [grid, setGrid] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  async function reload() {
    // Back to the loading state for the retry, so the grid never renders
    // before its data exists.
    setLoadError(null);
    setCatalogue(null);
    try {
      const [events, rules] = await Promise.all([
        notificationsApi.getNotificationCatalogue(),
        notificationsApi.getNotificationRoleRules(),
      ]);
      const effective = effectiveGrid(events, rules);
      setCatalogue(events);
      setSavedGrid(effective);
      setGrid(effective);
    } catch (caught) {
      setCatalogue([]);
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load notification settings.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const event of catalogue ?? []) {
      if (!byGroup.has(event.group)) byGroup.set(event.group, []);
      byGroup.get(event.group).push(event);
    }
    return [...byGroup.entries()];
  }, [catalogue]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — notification settings belong to one property.</p>;
  }

  if (catalogue === null || (!loadError && grid === null)) {
    return <Card state="loading" title="Staff notifications" />;
  }

  if (loadError) {
    return (
      <Card title="Staff notifications">
        <p role="alert" className={formStyles.errorBanner}>
          {loadError}
        </p>
        <Button variant="secondary" onClick={reload}>
          Try again
        </Button>
      </Card>
    );
  }

  const dirty = Object.keys(grid).some((key) => grid[key] !== savedGrid[key]);
  const matchesDefaults = (() => {
    const defaults = defaultGrid(catalogue);
    return Object.keys(grid).every((key) => grid[key] === defaults[key]);
  })();

  function toggle(eventType, role) {
    const key = cellKey(eventType, role);
    setGrid({ ...grid, [key]: !grid[key] });
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const rules = catalogue.flatMap((entry) =>
        ROLES.map(({ code }) => ({ eventType: entry.eventType, role: code, enabled: grid[cellKey(entry.eventType, code)] }))
      );
      const saved = await notificationsApi.saveNotificationRoleRules(rules);
      const effective = effectiveGrid(catalogue, saved);
      setSavedGrid(effective);
      setGrid(effective);
      setToast('Notification settings saved');
    } catch (caught) {
      setSaveError(caught instanceof ApiError ? caught.message : 'Could not save notification settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Card title="Staff notifications">
        <p className={styles.intro}>
          Choose which roles at this property get each notification in their bell. Everyone holding a ticked role
          receives it, including staff invited later. New guest QR orders also show an on-screen card.
        </p>
        {saveError && (
          <p role="alert" className={formStyles.errorBanner}>
            {saveError}
          </p>
        )}
        {isOffline && (
          <p role="status" className={formStyles.disabledNotice}>
            You&rsquo;re offline — changes can&rsquo;t be saved until the connection is back.
          </p>
        )}
        <form onSubmit={handleSave}>
          <div className={styles.tableWrap}>
            <table className={styles.grid}>
              <caption className={styles.srOnly}>Notification recipients by role</caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.eventHeader}>
                    Notification
                  </th>
                  {ROLES.map(({ code, label }) => (
                    <th key={code} scope="col" className={styles.roleHeader}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map(([group, events]) => (
                <tbody key={group}>
                  <tr>
                    <th scope="colgroup" colSpan={ROLES.length + 1} className={styles.groupHeader}>
                      {group}
                    </th>
                  </tr>
                  {events.map((entry) => (
                    <tr key={entry.eventType}>
                      <th scope="row" className={styles.eventCell}>
                        <span className={styles.eventLabel}>{entry.label}</span>
                        <span className={styles.eventDescription}>{entry.description}</span>
                      </th>
                      {ROLES.map(({ code, label }) => (
                        <td key={code} className={styles.checkCell}>
                          <input
                            type="checkbox"
                            className={formStyles.checkbox}
                            checked={grid[cellKey(entry.eventType, code)]}
                            onChange={() => toggle(entry.eventType, code)}
                            aria-label={`${entry.label}: ${label}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <div className={`${formStyles.actionsRow} ${styles.actions}`}>
            <Button type="submit" disabled={!dirty || saving || isOffline}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="secondary" disabled={!dirty || saving} onClick={() => setGrid(savedGrid)}>
              Discard changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={matchesDefaults || saving}
              onClick={() => setGrid(defaultGrid(catalogue))}
            >
              Restore defaults
            </Button>
          </div>
        </form>
      </Card>
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
