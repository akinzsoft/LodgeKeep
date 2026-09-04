import { useState } from 'react';
import {
  Card,
  KPICard,
  StatusPill,
  DataTable,
  IconBadge,
  Toast,
  ConfirmDialog,
  Skeleton,
} from './shared/components/index.js';
import { Money, formatMoney } from './shared/format/money.jsx';

/**
 * A visual showcase of the shared component set, exercising every state
 * DESIGN_SYSTEM.md §2 and TESTING.md's FE suite ask for. Not a screen the
 * product ships — a working demonstration that the components compose, so
 * "does this actually render" is checkable by eye and not only by test
 * assertions. Rendered inside `<AppShell>` (see `main.jsx`), which supplies
 * its own `<main>` — hence `<div>` here, not a second nested `<main>`.
 */
export function ComponentGallery() {
  const [toast, setToast] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const folioRows = [
    { id: 1, guest: 'Ada Bello', room: '204', status: 'confirmed', balance: '0.00' },
    { id: 2, guest: 'Sam Okoro', room: '112', status: 'pending', balance: '45000.00' },
    { id: 3, guest: 'Chidi Nwosu', room: '301', status: 'cancelled', balance: '0.00' },
  ];

  const toneFor = { confirmed: 'success', pending: 'warning', cancelled: 'danger' };
  const labelFor = { confirmed: 'Confirmed', pending: 'Pending', cancelled: 'Cancelled' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <h1>Lodgekeep — shared components</h1>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
        <KPICard label="Room nights booked" value="1,204" domain="booking" icon={<IconBadge domain="booking">B</IconBadge>} />
        <KPICard label="Revenue today" value={<Money amount="450000.00" currencyCode="NGN" />} domain="money" />
        <KPICard label="Loading example" state="loading" />
        <KPICard label="No data yet" state="empty" emptyMessage="No charges posted yet" />
      </section>

      <section style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <IconBadge domain="booking">B</IconBadge>
        <IconBadge domain="rooms">R</IconBadge>
        <IconBadge domain="guest">G</IconBadge>
        <IconBadge domain="money">M</IconBadge>
        {Object.entries(toneFor).map(([key, tone]) => (
          <StatusPill key={key} tone={tone} label={labelFor[key]} />
        ))}
        <StatusPill tone="info" label="In-house" />
        <StatusPill tone="neutral" label="Archived" />
      </section>

      <DataTable
        title="Arrivals"
        columns={[
          { key: 'guest', label: 'Guest' },
          { key: 'room', label: 'Room' },
          { key: 'status', label: 'Status', render: (r) => <StatusPill tone={toneFor[r.status]} label={labelFor[r.status]} /> },
          { key: 'balance', label: 'Balance', align: 'right', render: (r) => <Money amount={r.balance} currencyCode="NGN" /> },
        ]}
        rows={folioRows}
        rowKey={(r) => r.id}
        actions={(r) => <button type="button">View {r.guest}</button>}
        toolbar={<input placeholder="Search guests" aria-label="Search guests" />}
      />

      <Card state="loading" title="Loading card" />
      <Card state="error" title="Error card" errorMessage="Could not load reservations. Try again." />

      <Skeleton width="200px" height="24px" />

      <section style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <button type="button" onClick={() => setToast('Check-in complete')}>
          Show success toast
        </button>
        <button type="button" onClick={() => setConfirmOpen(true)}>
          Open confirm dialog
        </button>
      </section>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      {confirmOpen && (
        <ConfirmDialog
          title="Refund this payment?"
          consequence={`This posts a refund of ${formatMoney('45000.00', 'NGN')} to the guest's original payment method.`}
          requireReason
          onConfirm={() => setConfirmOpen(false)}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
