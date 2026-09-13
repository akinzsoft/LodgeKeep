import { useEffect, useState } from 'react';
import { Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';
import styles from './RegisterTab.module.css';

const AUTH_METHODS = [
  { value: 'signature', label: 'Signature' },
  { value: 'room_key', label: 'Room key presented' },
  { value: 'pin', label: 'PIN' },
];

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'room_charge', label: 'Charge to room' },
];

const ZERO = '0.00';

/** Groups unvoided order items by (menu item, split group) so repeated taps on the same tile show one line reading "×3", not three separate "×1" rows underneath. Each group remembers its own rows in insertion order, since "remove one" targets the most recently added row, not an arbitrary one. */
function groupOrderItems(items) {
  const order = [];
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.menu_item_id}:${item.split_group ?? 'none'}`;
    if (!byKey.has(key)) {
      byKey.set(key, { menuItemId: item.menu_item_id, splitGroup: item.split_group ?? null, rows: [] });
      order.push(key);
    }
    byKey.get(key).rows.push(item);
  }
  return order.map((key) => byKey.get(key));
}

/**
 * RegisterTab — PLAN.md Phase 4's Order screen (PRODUCT_REQUIREMENTS.md
 * §3.4): "the primary view... large touch targets... adding an item is one
 * tap." Deliberately not built on `DataTable`/`Card` the way every other
 * admin screen in this app is — this session's confirmed decision to
 * follow §3.4's own "the one place the admin design language bends"
 * framing, via `RegisterTab.module.css`'s `--control-h-pos` tiles.
 *
 * Split billing (this session's confirmed scope: item-group taps, no
 * drag-and-drop) — tapping a group number on a line assigns it there;
 * "Settle" then shows one settlement form per DISTINCT group actually
 * present, submitted together in one call, matching `settleOrder`'s own
 * "cover every group in one request" requirement.
 *
 * Bug fix (see `POSScreen`'s own header): every `Money` here used to
 * hardcode `currencyCode="NGN"` — `pos_menu_items`/`pos_orders` carry no
 * currency column of their own, so the real source of truth is the active
 * property's `base_currency`, now threaded in as a prop.
 *
 * UI/UX pass (user-reported: "make it a standard POS with best
 * experience"). Real, user-visible changes, none touching the backend
 * contract (confirmed with the user before building — no endpoint exists
 * to edit an existing line's quantity, and none was added):
 *
 * 1. **Category tabs + search** over the menu grid — `pos_menu_items.category`
 *    has been a real, always-populated column since Phase 4; nothing here
 *    ever read it before. A large real menu with no way to narrow it down
 *    is the single biggest gap between this screen and an actual POS.
 * 2. **Sold-out items stay visible, disabled** ("Sold out" badge) instead of
 *    silently disappearing — a cashier can now see the whole menu and know
 *    what's out, rather than wondering why a tile vanished.
 * 3. **Repeated taps merge into one line with a quantity badge**
 *    (`groupOrderItems`), with its own "+"/"−" controls — purely a DISPLAY
 *    grouping, confirmed with the user: each tap still creates a genuinely
 *    separate `pos_order_items` row (no backend change), "+" just taps the
 *    item again, "−" voids the single most-recently-added row in that
 *    group. The moment any real split-group assignment exists on the
 *    order, this screen falls back to the original one-row-per-line view
 *    (`anySplit`) so the existing, already-correct per-row split control
 *    keeps working completely unambiguously — grouping and free-form
 *    split billing were never designed to compose, and this scopes the new
 *    grouped view to exactly the common, unsplit case instead of guessing.
 * 4. **A real `ConfirmDialog` for voiding**, replacing the bare
 *    `window.prompt` this screen used before — same required-reason
 *    guarantee, consistent with every other reason-gated action in this
 *    app (`GuestOrdersTab`'s own reject flow).
 * 5. **Real tip and service-charge inputs on settlement** — the backend has
 *    posted these as real, separate, untaxed folio adjustments since this
 *    module's own review pass (see this file's CLAUDE.md status section:
 *    "tip/service-charge-actually-billed proof"), but no input for either
 *    ever existed on this screen; both silently submitted as a hardcoded
 *    "0.00" every time. A settlement panel is also the one place a
 *    cashier most needs to actually SEE the amount being charged before
 *    confirming a payment method — added a real per-group subtotal/tip/
 *    service-charge/grand-total breakdown, and payment-method choice is
 *    now a row of tappable tiles instead of a `<select>`.
 */
export function RegisterTab({ activeProperty, isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [outletId, setOutletId] = useState('');
  const [terminalId, setTerminalId] = useState('');

  const [openOrders, setOpenOrders] = useState([]);
  const [activeOrderId, setActiveOrderId] = useState(null);
  const [activeOrder, setActiveOrder] = useState(null);

  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [error, setError] = useState(null);
  const [settleResult, setSettleResult] = useState(null);
  const [settlementForms, setSettlementForms] = useState(null);
  const [voidingRow, setVoidingRow] = useState(null);

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch((caught) => {
        setOutlets([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load outlets.');
      });
  }, []);

  async function loadOutletContext(id) {
    try {
      const [terminalList, menuList, orders] = await Promise.all([
        posApi.listTerminals(id),
        posApi.listMenuItems(id),
        posApi.listOrders({ outletId: id, status: 'open' }),
      ]);
      setTerminals(terminalList);
      setMenuItems(menuList);
      setOpenOrders(orders);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this outlet.');
    }
  }

  function handleSelectOutlet(id) {
    setOutletId(id);
    setTerminalId('');
    setActiveOrderId(null);
    setActiveOrder(null);
    setCategoryFilter('');
    setSearchQuery('');
    if (id) loadOutletContext(id);
  }

  async function loadActiveOrder(id) {
    try {
      setActiveOrder(await posApi.getOrder(id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this tab.');
    }
  }

  async function handleNewTab() {
    if (!terminalId) {
      setError('Select a terminal first.');
      return;
    }
    setError(null);
    try {
      const order = await posApi.openOrder({ outletId, terminalId, tableLabel: '' });
      setOpenOrders([...openOrders, order]);
      setActiveOrderId(order.id);
      await loadActiveOrder(order.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open a new tab.');
    }
  }

  async function handleAddItem(menuItemId) {
    setError(null);
    try {
      await posApi.addItem(activeOrderId, { menuItemId, quantity: 1 });
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add this item.');
    }
  }

  async function confirmVoid(reason) {
    const row = voidingRow;
    setVoidingRow(null);
    setError(null);
    try {
      await posApi.voidOrderItem(activeOrderId, row.id, reason);
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not void this item.');
    }
  }

  async function handleAssignGroup(item, group) {
    try {
      await posApi.assignItemSplitGroup(activeOrderId, item.id, group);
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not assign this item to a split group.');
    }
  }

  /** Splitting a still-merged line moves its WHOLE quantity into group 1 at once — further fine-grained control (moving one unit at a time between groups) happens through the per-row view this flips into (`anySplit`). */
  async function handleSplitLine(group) {
    setError(null);
    try {
      await Promise.all(group.rows.map((row) => posApi.assignItemSplitGroup(activeOrderId, row.id, 1)));
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not assign this item to a split group.');
    }
  }

  function beginSettlement() {
    setSettlementForms(
      distinctGroups.map((group) => ({
        splitGroup: group,
        method: 'cash',
        tipAmount: ZERO,
        serviceCharge: ZERO,
        roomChargeQuery: '',
        roomChargeGuest: null,
        authMethod: 'pin',
        authReference: '',
      }))
    );
  }

  async function handleSubmitSettlement(event) {
    event.preventDefault();
    setError(null);
    try {
      const result = await posApi.settleOrder(
        activeOrderId,
        settlementForms.map((form) => ({
          splitGroup: form.splitGroup,
          method: form.method,
          tipAmount: form.tipAmount || ZERO,
          serviceCharge: form.serviceCharge || ZERO,
          roomCharge:
            form.method === 'room_charge'
              ? { reservationId: form.roomChargeGuest?.reservationId, authMethod: form.authMethod, authReference: form.authReference }
              : undefined,
        }))
      );
      setSettleResult(result);
      setSettlementForms(null);
      setOpenOrders(openOrders.filter((o) => o.id !== activeOrderId));
      setActiveOrderId(null);
      setActiveOrder(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not settle this tab.');
    }
  }

  /** Patches one settlement-form entry by index — the one place this screen mutates that array, used by every field below instead of each repeating its own clone-and-splice. */
  function patchSettlementForm(index, patch) {
    setSettlementForms((forms) => forms.map((form, i) => (i === index ? { ...form, ...patch } : form)));
  }

  async function handleGuestSearch(index, query) {
    patchSettlementForm(index, { roomChargeQuery: query });
    if (!query) return;
    try {
      const results = await posApi.findInHouseForCharge(query);
      patchSettlementForm(index, { roomChargeResults: results });
    } catch {
      // Search is a convenience — a failed lookup just leaves the last-known result list.
    }
  }

  const unvoidedItems = activeOrder?.items.filter((item) => !item.voided_at) ?? [];
  const runningTotal = sumMoney(unvoidedItems.map((item) => multiplyMoney(item.unit_price, item.quantity)));
  const distinctGroups = [...new Set(unvoidedItems.map((item) => item.split_group ?? null))];
  // Real, unambiguous flag for "has anyone actually started splitting this
  // tab" — deliberately not `distinctGroups.length > 1`, which would
  // silently flip back to the merged view the moment every remaining item
  // happens to share one group (e.g. everything moved into group 1).
  const anySplit = unvoidedItems.some((item) => item.split_group != null);

  function groupTotal(splitGroup) {
    const lines = unvoidedItems.filter((item) => (item.split_group ?? null) === splitGroup);
    return sumMoney(lines.map((item) => multiplyMoney(item.unit_price, item.quantity)));
  }

  function menuItemName(id) {
    return menuItems.find((m) => m.id === id)?.name ?? `#${id}`;
  }

  const categories = [...new Set(menuItems.map((item) => item.category))].sort();
  const filteredMenuItems = menuItems.filter(
    (item) =>
      (categoryFilter === '' || item.category === categoryFilter) &&
      (searchQuery.trim() === '' || item.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
  );

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Orders cannot be settled until connectivity returns.</p>}

      {settleResult && (
        <div className={styles.runningTotal}>
          <span>Tab settled.</span>
          <Button variant="ghost" onClick={() => setSettleResult(null)}>
            New sale
          </Button>
        </div>
      )}

      {!settleResult && (
        <>
          <div className={styles.stationBar}>
            <label className={styles.stationField}>
              <span className={formStyles.label}>Outlet</span>
              <select className={formStyles.select} value={outletId} onChange={(e) => handleSelectOutlet(e.target.value)}>
                <option value="">Select an outlet</option>
                {(outlets ?? []).map((outlet) => (
                  <option key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.stationField}>
              <span className={formStyles.label}>Terminal</span>
              <select className={formStyles.select} value={terminalId} onChange={(e) => setTerminalId(e.target.value)} disabled={!outletId}>
                <option value="">Select a terminal</option>
                {terminals.map((terminal) => (
                  <option key={terminal.id} value={terminal.id}>
                    {terminal.device_ref}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {outletId && (
            <div className={styles.tabsBar}>
              {openOrders.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  className={`${styles.tabChip} ${activeOrderId === order.id ? styles.tabChipActive : ''}`.trim()}
                  onClick={() => {
                    setActiveOrderId(order.id);
                    loadActiveOrder(order.id);
                  }}
                >
                  {order.table_label || `Tab #${order.id}`}
                </button>
              ))}
              <button type="button" className={styles.tabChip} onClick={handleNewTab} disabled={isOffline}>
                + New tab
              </button>
            </div>
          )}

          {activeOrder && (
            <div className={styles.layout}>
              <div>
                <div className={styles.menuControls}>
                  <input
                    className={styles.searchInput}
                    type="search"
                    placeholder="Search the menu…"
                    aria-label="Search the menu"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <div className={styles.categoryTabs}>
                    <button
                      type="button"
                      className={`${styles.categoryChip} ${categoryFilter === '' ? styles.categoryChipActive : ''}`.trim()}
                      onClick={() => setCategoryFilter('')}
                    >
                      All
                    </button>
                    {categories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        className={`${styles.categoryChip} ${categoryFilter === category ? styles.categoryChipActive : ''}`.trim()}
                        onClick={() => setCategoryFilter(category)}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.menuGrid}>
                  {filteredMenuItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={styles.menuTile}
                      onClick={() => handleAddItem(item.id)}
                      disabled={isOffline || !item.is_available}
                    >
                      <span>{item.name}</span>
                      {item.is_available ? (
                        <Money amount={item.price} currencyCode={activeProperty.base_currency} />
                      ) : (
                        <span className={styles.soldOutBadge}>Sold out</span>
                      )}
                    </button>
                  ))}
                  {filteredMenuItems.length === 0 && <p className={formStyles.disabledNotice}>No menu items match this search.</p>}
                </div>
              </div>

              <div className={styles.orderPanel}>
                <div className={styles.orderLines}>
                  {anySplit
                    ? unvoidedItems.map((item) => (
                        <div key={item.id} className={styles.tabLine}>
                          <span>
                            {item.quantity}× {menuItemName(item.menu_item_id)}
                          </span>
                          <span className={styles.tabLineActions}>
                            <Money amount={multiplyMoney(item.unit_price, item.quantity)} currencyCode={activeProperty.base_currency} />
                            <Button
                              size="compact"
                              variant="ghost"
                              onClick={() => setVoidingRow({ id: item.id, name: menuItemName(item.menu_item_id) })}
                              disabled={isOffline}
                            >
                              Void
                            </Button>
                            <select
                              className={formStyles.select}
                              value={item.split_group ?? ''}
                              onChange={(e) => handleAssignGroup(item, e.target.value ? Number(e.target.value) : null)}
                            >
                              <option value="">No group</option>
                              <option value="1">Group 1</option>
                              <option value="2">Group 2</option>
                              <option value="3">Group 3</option>
                            </select>
                          </span>
                        </div>
                      ))
                    : groupOrderItems(unvoidedItems).map((group) => {
                        const lastRow = group.rows[group.rows.length - 1];
                        const quantity = group.rows.reduce((sum, row) => sum + row.quantity, 0);
                        const lineTotal = sumMoney(group.rows.map((row) => multiplyMoney(row.unit_price, row.quantity)));
                        return (
                          <div key={`${group.menuItemId}:${group.splitGroup ?? 'none'}`} className={styles.tabLine}>
                            <span className={styles.tabLineName}>
                              <span className={styles.quantityBadge}>×{quantity}</span> {menuItemName(group.menuItemId)}
                            </span>
                            <span className={styles.tabLineActions}>
                              <Money amount={lineTotal} currencyCode={activeProperty.base_currency} />
                              <Button size="compact" variant="secondary" onClick={() => handleAddItem(group.menuItemId)} disabled={isOffline} aria-label={`Add another ${menuItemName(group.menuItemId)}`}>
                                +
                              </Button>
                              <Button
                                size="compact"
                                variant="ghost"
                                onClick={() => setVoidingRow({ id: lastRow.id, name: menuItemName(group.menuItemId) })}
                                disabled={isOffline}
                                aria-label={`Remove one ${menuItemName(group.menuItemId)}`}
                              >
                                −
                              </Button>
                              <button type="button" className={formStyles.label} onClick={() => handleSplitLine(group)}>
                                Split
                              </button>
                            </span>
                          </div>
                        );
                      })}
                  {unvoidedItems.length === 0 && <p className={formStyles.disabledNotice}>Tap a menu item to add it to this tab.</p>}
                </div>

                <div className={styles.runningTotal}>
                  <span>Total</span>
                  <Money amount={runningTotal} currencyCode={activeProperty.base_currency} />
                </div>

                {!settlementForms && unvoidedItems.length > 0 && (
                  <Button onClick={beginSettlement} disabled={isOffline} className={styles.settleButton}>
                    Settle
                  </Button>
                )}
              </div>
            </div>
          )}

          {settlementForms && (
            <div className={styles.settlementOverlay} role="presentation" onClick={() => setSettlementForms(null)}>
              <form
                className={styles.settlementPanel}
                onSubmit={handleSubmitSettlement}
                onClick={(event) => event.stopPropagation()}
              >
                <h2 className={styles.settlementTitle}>Settle {settlementForms.length > 1 ? 'this split tab' : 'this tab'}</h2>

                {settlementForms.map((form, index) => {
                  const subtotal = groupTotal(form.splitGroup);
                  const grandTotal = sumMoney([subtotal, form.tipAmount || ZERO, form.serviceCharge || ZERO]);
                  return (
                    <div key={form.splitGroup ?? 'all'} className={styles.settlementGroup}>
                      <h3 className={styles.settlementGroupTitle}>{form.splitGroup ? `Group ${form.splitGroup}` : 'Whole tab'}</h3>

                      <div className={styles.settlementLine}>
                        <span>Subtotal</span>
                        <Money amount={subtotal} currencyCode={activeProperty.base_currency} />
                      </div>

                      <div className={formStyles.row}>
                        <label className={formStyles.field}>
                          <span className={formStyles.label}>Tip</span>
                          <input
                            className={formStyles.input}
                            type="number"
                            step="0.01"
                            min="0"
                            value={form.tipAmount}
                            onChange={(e) => patchSettlementForm(index, { tipAmount: e.target.value })}
                          />
                        </label>
                        <label className={formStyles.field}>
                          <span className={formStyles.label}>Service charge</span>
                          <input
                            className={formStyles.input}
                            type="number"
                            step="0.01"
                            min="0"
                            value={form.serviceCharge}
                            onChange={(e) => patchSettlementForm(index, { serviceCharge: e.target.value })}
                          />
                        </label>
                      </div>

                      <div className={`${styles.settlementLine} ${styles.settlementGrandTotal}`}>
                        <span>Amount to charge</span>
                        <Money amount={grandTotal} currencyCode={activeProperty.base_currency} />
                      </div>

                      <div className={styles.paymentMethodRow}>
                        {PAYMENT_METHODS.map((method) => (
                          <Button
                            key={method.value}
                            type="button"
                            variant={form.method === method.value ? 'primary' : 'secondary'}
                            onClick={() => patchSettlementForm(index, { method: method.value })}
                          >
                            {method.label}
                          </Button>
                        ))}
                      </div>

                      {form.method === 'room_charge' && (
                        <div className={formStyles.form}>
                          <input
                            className={formStyles.input}
                            placeholder="Room number or guest name"
                            value={form.roomChargeQuery}
                            onChange={(e) => handleGuestSearch(index, e.target.value)}
                          />
                          <select
                            className={formStyles.select}
                            value={form.roomChargeGuest?.reservationId ?? ''}
                            onChange={(e) => {
                              const guest = form.roomChargeResults?.find((g) => String(g.reservationId) === e.target.value);
                              patchSettlementForm(index, { roomChargeGuest: guest });
                            }}
                          >
                            <option value="">Select guest</option>
                            {(form.roomChargeResults ?? []).map((guest) => (
                              <option key={guest.reservationId} value={guest.reservationId}>
                                Room {guest.roomNumber} — {guest.guestFirstName} {guest.guestLastName}
                              </option>
                            ))}
                          </select>
                          <div className={formStyles.row}>
                            <select
                              className={formStyles.select}
                              value={form.authMethod}
                              onChange={(e) => patchSettlementForm(index, { authMethod: e.target.value })}
                            >
                              {AUTH_METHODS.map((m) => (
                                <option key={m.value} value={m.value}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                            <input
                              className={formStyles.input}
                              placeholder="e.g. PIN entered"
                              value={form.authReference}
                              onChange={(e) => patchSettlementForm(index, { authReference: e.target.value })}
                              required
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className={formStyles.actionsRow}>
                  <Button type="submit" disabled={isOffline}>
                    Confirm settlement
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setSettlementForms(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          )}

          {voidingRow && (
            <ConfirmDialog
              title="Void item"
              consequence={`This removes "${voidingRow.name}" from the tab. This cannot be undone.`}
              requireReason
              confirmLabel="Void"
              onConfirm={confirmVoid}
              onCancel={() => setVoidingRow(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
