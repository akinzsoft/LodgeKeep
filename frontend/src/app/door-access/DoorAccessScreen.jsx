import { useCallback, useEffect, useState } from 'react';
import { doorAccessApi, ApiError } from '../../shared/api/index.js';
import { Card } from '../../shared/components/index.js';
import { RetrospectiveBanner } from './RetrospectiveBanner.jsx';
import { ImportTab } from './ImportTab.jsx';
import { AlertsTab } from './AlertsTab.jsx';
import { StayConfirmationsTab } from './StayConfirmationsTab.jsx';
import { SettingsTab } from './SettingsTab.jsx';
import styles from './DoorAccess.module.css';

/**
 * DoorAccessScreen — PLAN.md Phase 7, PRODUCT_REQUIREMENTS.md §3.23's "Door
 * Access & Fraud Alerts screens", narrowed to the confirmed manual_import
 * scope. Manager/admin/super_admin only (`door_access.view`; the API's 403 is
 * the real gate, the nav filter is convenience).
 *
 * `config` is screen-level state: the banner's last-import date, the import
 * tab's saved mapping and the timezone every tab formats times in all read
 * it, and an import or a settings save refreshes it for all of them.
 */
const TABS = [
  { key: 'alerts', label: 'Alerts' },
  { key: 'import', label: 'Import lock log' },
  { key: 'confirmations', label: 'Stay confirmations' },
  { key: 'settings', label: 'Settings' },
];

export function DoorAccessScreen({ isOffline = false }) {
  const [tab, setTab] = useState('alerts');
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [alertsVersion, setAlertsVersion] = useState(0);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await doorAccessApi.getConfig());
      setConfigError(null);
    } catch (caught) {
      setConfigError(caught instanceof ApiError ? caught.message : 'Could not load door access settings.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    loadConfig();
  }, [loadConfig]);

  function handleImported() {
    loadConfig();
    setAlertsVersion((v) => v + 1);
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Door Access</h1>
      <RetrospectiveBanner config={config} />

      <div className={styles.tabs} role="tablist" aria-label="Door Access sections">
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

      <div className={styles.panel}>
        {configError ? (
          <Card state="error" title="Door Access" errorMessage={configError} />
        ) : config === null ? (
          <Card state="loading" title="Door Access" />
        ) : (
          <>
            {tab === 'alerts' && <AlertsTab key={alertsVersion} config={config} isOffline={isOffline} />}
            {tab === 'import' && (
              <ImportTab config={config} isOffline={isOffline} onImported={handleImported} onOpenSettings={() => setTab('settings')} />
            )}
            {tab === 'confirmations' && <StayConfirmationsTab config={config} />}
            {tab === 'settings' && <SettingsTab config={config} isOffline={isOffline} onSaved={setConfig} />}
          </>
        )}
      </div>
    </div>
  );
}
