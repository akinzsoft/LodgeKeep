import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import { guestOrderStatusTone, guestOrderStatusLabel, guestOrderPaymentTone, guestOrderPaymentLabel } from '../../qr-order/status.js';
import formStyles from './POSForm.module.css';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'received', label: 'Received' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'on_the_way', label: 'On the way' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'auto_rejected', label: 'Auto-rejected' },
];

/**
 * GuestOrdersTab — PLAN.md Phase 6's QR self-ordering staff queue
 * (`pos.operate`, matching `TicketsTab`'s own room for reading, but this is
 * a genuinely separate view from that one: `TicketsTab` shows STAFF-opened
 * tabs, this shows GUEST-opened ones, each with its own real lifecycle
 * (`pos_guest_orders.status`: received -> preparing -> on_the_way, or
 * rejected/auto_rejected) and its own payment state a staff-opened tab
 * never has (a guest order settles or reverses payment on its own, before
 * a person ever touches it).
 *
 * Reject is `ConfirmDialog`-gated with a required reason — it reverses a
 * real payment already taken (a full refund for a paid card order, or a
 * voided settlement for one already charged to a room —
 * `qr-ordering/service.js`'s own `reverseGuestOrderPayment`), the same
 * DESIGN_SYSTEM.md §2 money/irreversible-action rule `NewImportTab.jsx`'s
 * commit confirmation already follows. Accept/mark-on-the-way are plain
 * buttons — neither is financial or irreversible in that sense.
 *
 * Bug fix (see `POSScreen`'s own header): the subtotal column used to
 * hardcode a literal NGN currency code — `pos_orders` carries no currency
 * column of its own, so the real source of truth is the active property's
 * `base_currency`, now threaded in as a prop.
 */
export function GuestOrdersTab({ activeProperty }) {
  const [statusFilter, setStatusFilter] = useState('');
  const [orders, setOrders] = useState(null);
  const [itemsByOrderId, setItemsByOrderId] = useState({});
  const [menuItemsById, setMenuItemsById] = useState({});
  const [error, setError] = useState(null);

  const [actionError, setActionError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);

  async function reload() {
    try {
      const [rows, menuItems] = await Promise.all([posApi.listGuestOrders({ status: statusFilter || undefined }), posApi.listMenuItems()]);
      setOrders(rows);
      setMenuItemsById(Object.fromEntries(menuItems.map((item) => [item.id, item])));
      const detail = await Promise.all(rows.map((row) => posApi.getOrder(row.pos_order_id)));
      setItemsByOrderId(Object.fromEntries(rows.map((row, index) => [row.id, detail[index].items.filter((item) => !item.voided_at)])));
      setError(null);
    } catch (caught) {
      setOrders([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load guest orders.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount/filter-change; no data-fetching library exists yet to own this
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusFilter drives this refetch directly
  }, [statusFilter]);

  async function handleAccept(order) {
    setBusyId(order.id);
    setActionError(null);
    try {
      await posApi.acceptGuestOrder(order.id);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not accept this order.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkOnTheWay(order) {
    setBusyId(order.id);
    setActionError(null);
    try {
      await posApi.markGuestOrderOnTheWay(order.id);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not update this order.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(reason) {
    const orderId = rejectingId;
    setRejectingId(null);
    setBusyId(orderId);
    setActionError(null);
    try {
      await posApi.rejectGuestOrder(orderId, reason);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not reject this order.');
    } finally {
      setBusyId(null);
    }
  }

  function orderSubtotal(order) {
    const items = itemsByOrderId[order.id] ?? [];
    return sumMoney(items.map((item) => multiplyMoney(item.unit_price, item.quantity)));
  }

  function orderItemsSummary(order) {
    const items = itemsByOrderId[order.id] ?? [];
    if (items.length === 0) return '—';
    return items.map((item) => `${item.quantity}× ${menuItemsById[item.menu_item_id]?.name ?? `#${item.menu_item_id}`}`).join(', ');
  }

  return (
    <div className={formStyles.form}>
      {actionError && (
        <p role="alert" className={formStyles.errorBanner}>
          {actionError}
        </p>
      )}

      {/* Outside DataTable's own toolbar slot, deliberately — Card only
          renders `children` (toolbar included) while `state === 'success'`,
          the same gap CLAUDE.md's own POS/reporting review pass already
          found and fixed elsewhere in this codebase (`DiscrepanciesTab.jsx`'s
          own comment). "No orders right now" is the ordinary, common state
          for this queue, not an edge case a filter control should vanish on. */}
      <label className={formStyles.field}>
        <span className={formStyles.label}>Status</span>
        <select className={formStyles.select} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <DataTable
        title="Guest orders"
        state={orders === null ? 'loading' : error ? 'error' : orders.length === 0 ? 'empty' : 'success'}
        errorMessage={error}
        emptyMessage="No guest orders match this filter."
        columns={[
          { key: 'table_label', label: 'Table / room', render: (row) => row.table_label ?? '—' },
          { key: 'guest_name', label: 'Guest', render: (row) => row.guest_name || row.guest_contact || '—' },
          { key: 'items', label: 'Items', render: (row) => orderItemsSummary(row) },
          { key: 'subtotal', label: 'Subtotal', align: 'right', render: (row) => <Money amount={orderSubtotal(row)} currencyCode={activeProperty.base_currency} /> },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={guestOrderStatusTone(row.status)} label={guestOrderStatusLabel(row.status)} /> },
          {
            key: 'payment_status',
            label: 'Payment',
            render: (row) => <StatusPill tone={guestOrderPaymentTone(row.payment_status)} label={guestOrderPaymentLabel(row.payment_status)} />,
          },
        ]}
        rows={orders ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            {row.status === 'received' && (
              <Button size="compact" loading={busyId === row.id} onClick={() => handleAccept(row)}>
                Accept
              </Button>
            )}
            {row.status === 'preparing' && (
              <Button size="compact" loading={busyId === row.id} onClick={() => handleMarkOnTheWay(row)}>
                Mark on the way
              </Button>
            )}
            {(row.status === 'received' || row.status === 'preparing' || row.status === 'on_the_way') && (
              <Button size="compact" variant="danger" disabled={busyId === row.id} onClick={() => setRejectingId(row.id)}>
                Reject
              </Button>
            )}
          </>
        )}
      />

      {rejectingId !== null && (
        <ConfirmDialog
          title="Reject this guest order?"
          consequence="The guest will not be served this order. Any payment already taken (a card capture or a room charge) will be reversed in full."
          requireReason
          confirmLabel="Reject order"
          onConfirm={handleReject}
          onCancel={() => setRejectingId(null)}
        />
      )}

      <Card title="About this queue" state="success">
        <p className={formStyles.hint}>
          Orders placed by guests scanning a QR code appear here, separately from tabs opened at the register (see the Tickets tab). A card order is
          paid before it reaches this queue; a room-charge order is verified against the room&rsquo;s own in-house guest before it does.
        </p>
      </Card>
    </div>
  );
}
