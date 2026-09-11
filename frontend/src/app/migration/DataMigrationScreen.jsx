import { useState } from 'react';
import { TemplatesTab } from './TemplatesTab.jsx';
import { NewImportTab } from './NewImportTab.jsx';
import { HistoryTab } from './HistoryTab.jsx';
import styles from './DataMigrationScreen.module.css';

/**
 * DataMigrationScreen — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20 ("Admin only, and typically used once.
 * Optimise for confidence, not convenience."). Own top-level screen filed
 * under SETUP, matching AR/Group Blocks' own precedent (a genuine
 * multi-step workflow — upload, dry run, duplicate review, conflicts,
 * commit/progress, history — is big enough to need several tabs of its
 * own), not Offboarding's "tuck into an existing screen" shape (that one is
 * a single coherent action with a status/retry/download tail).
 *
 * `activeRunId` is screen-level state, not per-tab — the same "select once,
 * act across tabs" idiom `GroupBlocksScreen`'s own `selectedBlock` already
 * established: clicking "Resume" on a run in History switches to New Import
 * with that run already loaded, rather than forcing a fresh upload.
 */
const TABS = [
  { key: 'templates', label: 'Templates' },
  { key: 'new_import', label: 'New Import' },
  { key: 'history', label: 'History' },
];

export function DataMigrationScreen({ isOffline = false }) {
  const [tab, setTab] = useState('templates');
  const [activeRunId, setActiveRunId] = useState(null);

  function handleResume(runId) {
    setActiveRunId(runId);
    setTab('new_import');
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Data Migration</h1>

      <div className={styles.tabs} role="tablist" aria-label="Data Migration sections">
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
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'new_import' && (
          <NewImportTab isOffline={isOffline} activeRunId={activeRunId} onRunChange={setActiveRunId} />
        )}
        {tab === 'history' && <HistoryTab isOffline={isOffline} onResume={handleResume} />}
      </div>
    </div>
  );
}
