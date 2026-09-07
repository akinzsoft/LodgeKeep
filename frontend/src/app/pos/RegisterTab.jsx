import { useEffect, useState } from 'react';
import { Button } from '../../shared/components/index.js';
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
 */
export function RegisterTab({ isOffline = false }) {
  const [outlets, setOutlets] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [outletId, setOutletId] = useState('');
  const [terminalId, setTerminalId] = useState('');

  const [openOrders, setOpenOrders] = useState([]);
  const [activeOrderId, setActiveOrderId] = useState(null);
  const [activeOrder, setActiveOrder] = useState(null);

  const [error, setError] = useState(null);
  const [settleResult, setSettleResult] = useState(null);
  const [settlementForms, setSettlementForms] = useState(null);

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

  async function handleAddItem(menuItem) {
    setError(null);
    try {
      await posApi.addItem(activeOrderId, { menuItemId: menuItem.id, quantity: 1 });
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add this item.');
    }
  }

  async function handleVoidItem(item) {
    // A plain browser prompt for the reason, not a full ConfirmDialog —
    // pragmatic for this pass; DESIGN_SYSTEM.md's "money confirmations
    // require a reason field" rule is satisfied (non-empty text is
    // required before the call proceeds, and it feeds the same audit
    // trail every other void does), just via a lighter-weight control
    // than the rest of this app uses.
    const reason = window.prompt('Reason for voiding this item?');
    if (!reason) return;
    try {
      await posApi.voidOrderItem(activeOrderId, item.id, reason);
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

  function beginSettlement() {
    setSettlementForms(
      distinctGroups.map((group) => ({
        splitGroup: group,
        method: 'cash',
        tipAmount: '0.00',
        serviceCharge: '0.00',
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
          tipAmount: form.tipAmount,
          serviceCharge: form.serviceCharge,
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
          <div className={formStyles.row}>
            <label className={formStyles.field}>
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
            <label className={formStyles.field}>
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
                <div className={styles.menuGrid}>
                  {menuItems
                    .filter((item) => item.is_available)
                    .map((item) => (
                      <button key={item.id} type="button" className={styles.menuTile} onClick={() => handleAddItem(item)} disabled={isOffline}>
                        <span>{item.name}</span>
                        <Money amount={item.price} currencyCode="NGN" />
                      </button>
                    ))}
                </div>
              </div>

              <div>
                {unvoidedItems.map((item) => (
                  <div key={item.id} className={styles.tabLine}>
                    <span>
                      {item.quantity}× {menuItems.find((m) => m.id === item.menu_item_id)?.name ?? `#${item.menu_item_id}`}
                    </span>
                    <span>
                      <Money amount={multiplyMoney(item.unit_price, item.quantity)} currencyCode="NGN" />
                      <Button size="compact" variant="ghost" onClick={() => handleVoidItem(item)} disabled={isOffline}>
                        Void
                      </Button>
                      {distinctGroups.length > 1 || item.split_group ? (
                        <select value={item.split_group ?? ''} onChange={(e) => handleAssignGroup(item, e.target.value ? Number(e.target.value) : null)}>
                          <option value="">No group</option>
                          <option value="1">Group 1</option>
                          <option value="2">Group 2</option>
                          <option value="3">Group 3</option>
                        </select>
                      ) : (
                        <button type="button" className={formStyles.label} onClick={() => handleAssignGroup(item, 1)}>
                          Split
                        </button>
                      )}
                    </span>
                  </div>
                ))}

                <div className={styles.runningTotal}>
                  <span>Total</span>
                  <Money amount={runningTotal} currencyCode="NGN" />
                </div>

                {!settlementForms && unvoidedItems.length > 0 && (
                  <Button onClick={beginSettlement} disabled={isOffline}>
                    Settle
                  </Button>
                )}

                {settlementForms && (
                  <form className={formStyles.form} onSubmit={handleSubmitSettlement}>
                    {settlementForms.map((form, index) => (
                      <div key={form.splitGroup ?? 'all'} className={formStyles.row}>
                        <span className={formStyles.label}>{form.splitGroup ? `Group ${form.splitGroup}` : 'Whole tab'}</span>
                        <select
                          className={formStyles.select}
                          value={form.method}
                          onChange={(e) => patchSettlementForm(index, { method: e.target.value })}
                        >
                          <option value="cash">Cash</option>
                          <option value="card">Card</option>
                          <option value="room_charge">Charge to room</option>
                        </select>

                        {form.method === 'room_charge' && (
                          <>
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
                          </>
                        )}
                      </div>
                    ))}
                    <div className={formStyles.actionsRow}>
                      <Button type="submit" disabled={isOffline}>
                        Confirm settlement
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setSettlementForms(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
