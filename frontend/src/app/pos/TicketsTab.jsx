import { useEffect, useState } from 'react';
import { Card, DataTable } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * TicketsTab — PLAN.md Phase 4's "Kitchen/bar ticket — printed or
 * displayed, so the order reaches whoever makes it" (PRODUCT_REQUIREMENTS.md
 * §3.4). This session's confirmed decision: a live on-screen queue of open
 * tabs, not a physical print — no printer hardware exists in this
 * environment. A plain read of the same order/item data the Register tab
 * already writes, not a second workflow with its own prep-status states
 * (that vocabulary — "received / preparing / on its way" — is
 * PRODUCT_REQUIREMENTS.md's own language for the deferred guest QR
 * self-ordering flow, Phase 6, not this one).
 */
export function TicketsTab() {
  const [orders, setOrders] = useState(null);
  const [menuItemsById, setMenuItemsById] = useState({});
  const [error, setError] = useState(null);

  async function reload() {
    try {
      const [openOrders, menuItems] = await Promise.all([posApi.listOrders({ status: 'open' }), posApi.listMenuItems()]);
      setMenuItemsById(Object.fromEntries(menuItems.map((item) => [item.id, item])));
      const withItems = await Promise.all(
        openOrders.map(async (order) => ({ order, detail: await posApi.getOrder(order.id) }))
      );
      setOrders(withItems);
    } catch (caught) {
      setOrders([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load open tickets.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  return (
    <div className={formStyles.form}>
      <Card
        title="Open tickets"
        state={orders === null ? 'loading' : error ? 'error' : orders.length === 0 ? 'empty' : 'success'}
        emptyMessage="No open tabs right now."
        errorMessage={error}
      >
        {(orders ?? []).map(({ order, detail }) => (
          <Card key={order.id} title={order.table_label ? `Table ${order.table_label}` : `Order ${order.id}`}>
            <DataTable
              state={detail.items.filter((item) => !item.voided_at).length === 0 ? 'empty' : 'success'}
              emptyMessage="No items on this tab yet."
              columns={[
                { key: 'quantity', label: 'Qty', align: 'right' },
                { key: 'menu_item_id', label: 'Item', render: (row) => menuItemsById[row.menu_item_id]?.name ?? `#${row.menu_item_id}` },
              ]}
              rows={detail.items.filter((item) => !item.voided_at)}
              rowKey={(row) => row.id}
            />
          </Card>
        ))}
      </Card>
    </div>
  );
}
