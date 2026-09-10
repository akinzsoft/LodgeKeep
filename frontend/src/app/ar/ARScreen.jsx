import { useState } from 'react';
import { AccountsTab } from './AccountsTab.jsx';
import { InvoicesTab } from './InvoicesTab.jsx';
import { AgeingTab } from './AgeingTab.jsx';
import { PaymentsTab } from './PaymentsTab.jsx';
import styles from './ARScreen.module.css';

/**
 * ARScreen — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.9 ("Company
 * invoicing, credit management, outstanding balance tracking, payment
 * collection workflows"). Four tabs against the same underlying AR
 * accounts, the same self-contained multi-tab pattern `POSScreen`/
 * `HousekeepingScreen`/`CashieringScreen` already established — no router
 * in this app yet. Filed under SETUP in `nav-config.js` (back-office,
 * gated on `ar.view`), not MAIN — PRODUCT_REQUIREMENTS.md itself files
 * Accounts Receivable under "Back-office screens," alongside Night Audit/
 * Reporting, not a front-line operational screen.
 *
 * Company-profile CRUD itself lives on the Profiles screen's own
 * "Companies" tab (this session's confirmed decision), not here — this
 * screen only references a company by id.
 */
const TABS = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'ageing', label: 'Ageing' },
  { key: 'payments', label: 'Payments' },
];

export function ARScreen({ isOffline = false }) {
  const [tab, setTab] = useState('accounts');

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Accounts Receivable</h1>

      <div className={styles.tabs} role="tablist" aria-label="Accounts Receivable sections">
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
        {tab === 'accounts' && <AccountsTab isOffline={isOffline} />}
        {tab === 'invoices' && <InvoicesTab isOffline={isOffline} />}
        {tab === 'ageing' && <AgeingTab isOffline={isOffline} />}
        {tab === 'payments' && <PaymentsTab isOffline={isOffline} />}
      </div>
    </div>
  );
}
