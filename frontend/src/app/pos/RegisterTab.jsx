import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney, percentOfMoney } from '../../shared/money.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import { openPaystackPopup } from '../../shared/paystack.js';
import { CategoryIcon, AllCategoriesIcon, PaymentMethodIcon, TrashIcon } from './registerCategoryIcons.jsx';
import formStyles from './POSForm.module.css';
import styles from './RegisterTab.module.css';

const AUTH_METHODS = [
  { value: 'signature', label: 'Signature' },
  { value: 'room_key', label: 'Room key presented' },
  { value: 'pin', label: 'PIN' },
];

// Card and NQR both collect the money on screen through Paystack before the
// tab settles (`collectPaystackPayment`): Card opens Paystack with every
// channel the merchant account supports (card, USSD, transfer, ...), NQR a
// QR-only checkout the guest scans with their banking app. Both settle as
// `method: 'card'`; `tender` is what tells them apart on the settlement.
// The three primary tender buttons the reference design shows in one row.
// "Charge to room" is real, tested, pre-existing functionality this
// redesign preserves rather than drops — kept reachable as its own smaller
// link below the row instead of a 4th equally-weighted button, matching
// the reference's own literal 3-button row exactly.
const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash', tender: 'cash' },
  { value: 'card', label: 'Card', tender: 'card' },
  { value: 'card', label: 'NQR', tender: 'nqr' },
];

/** A Paystack checkout that ended without captured money — its message is meant for the cashier as-is. */
class PaymentNotCompletedError extends Error {}

const TENDER_LABELS = { cash: 'Cash', card: 'Card', nqr: 'NQR', room_charge: 'Charge to room' };

const ZERO = '0.00';

// Layout pass (user-reported): the ticket's own "Service %" input is gone —
// service is now a fixed, non-editable rate, computed against the real
// server-verified subtotal exactly like the cashier-typed version used to
// be (`percentOfMoney`, same exact-decimal arithmetic). No tip concept
// remains either (the Tip input is gone too) — `handleSubmitSettlement`
// simply never sends a `tipAmount`, and the backend's own `settleOrder`
// already defaults a missing one to "0.00" (confirmed by reading
// `pos/service.js` directly), so this is not a breaking payload change.
const SERVICE_CHARGE_PERCENT = '7.5';

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

function defaultSettlementForm(splitGroup) {
  return {
    splitGroup,
    method: 'cash',
    // `tenderLabel` tracks which tender the cashier picked, separately from
    // `method` — "Card" and "NQR" both submit `method: 'card'` (see
    // `PAYMENT_METHODS`' own header). Layout pass: the three tender buttons
    // no longer show a visual highlight for whichever is picked (user-
    // reported: "no highlighted/primary state on any one of them"), but
    // `tenderLabel` is still tracked — `aria-pressed` on each button still
    // conveys the real selection to assistive tech, and it's still needed
    // to distinguish "Card" from "NQR" even though both submit identically.
    tenderLabel: 'Cash',
    tender: 'cash',
    // Optional — Paystack's receipt goes here; blank, the cashier's own email stands in.
    customerEmail: '',
    roomChargeQuery: '',
    roomChargeGuest: null,
    roomChargeResults: [],
    authMethod: 'pin',
    authReference: '',
  };
}

/**
 * RegisterTab — PLAN.md Phase 4's Order screen (PRODUCT_REQUIREMENTS.md
 * §3.4): "the primary view... large touch targets... adding an item is one
 * tap."
 *
 * ── VISUAL REDESIGN (user-reported: a fast, touch-first "Register" panel —
 * dark, embedded panel with a category rail, menu grid, and an always-
 * visible order ticket) ──────────────────────────────────────────────────
 *
 * Four real product forks were confirmed with the user before building
 * (AskUserQuestion), since the mockup's own literal text left them open:
 *
 * 1. **NQR** — originally recorded like Card with no real payment behind
 *    it. Card and NQR now collect the money on screen through Paystack
 *    before the tab settles (`collectPaystackPayment`); see
 *    `PAYMENT_METHODS`' own header.
 * 2. **Split billing** — the mockup's single always-visible ticket has no
 *    room for the existing multi-group settlement flow. Kept, not
 *    dropped: a "Split bill" action opens the pre-existing (now restyled)
 *    multi-group overlay; the common, unsplit case settles inline in the
 *    ticket panel itself with no modal at all.
 * 3. **"Service %"** — this codebase's `serviceCharge` has always been a
 *    flat amount the cashier types; there was no percentage concept
 *    anywhere. This originally became a cashier-typed percent, computed
 *    against the real, server-verified subtotal via `percentOfMoney`
 *    (exact BigInt-cents arithmetic, `shared/money.js`); a later layout
 *    pass (user-reported, no Tip input and no editable Service % field —
 *    "Subtotal, Service (7.5%, fixed), Total" only) fixed the rate to
 *    `SERVICE_CHARGE_PERCENT` and dropped Tip entirely — the computed flat
 *    amount is still what actually submits, so the backend contract is
 *    unchanged either way.
 * 4. **The Tax line** — the mockup's own totals list doesn't name it, but
 *    dropping it would silently reintroduce the exact bug this file's own
 *    settlement-preview fix (below) exists to close. Kept, conditionally
 *    shown only when genuinely nonzero (unchanged by the later layout
 *    pass above) — this dev tenant has no tax configured, so in practice
 *    the ticket shows exactly Subtotal/Service/Total as that pass asked,
 *    but a real VAT-configured property still sees its real tax line
 *    rather than having it silently hidden.
 *
 * The always-visible ticket needed the settlement-preview fetch (below) to
 * become REACTIVE — it used to run only once, when a separate "Settle"
 * button was clicked; now `settlementForms` is kept in sync with the
 * order's own real split groups by the effect just below the derived
 * `distinctGroups`/`anySplit` values, re-fetching the preview whenever the
 * real set of groups changes (not on every render — keyed on a stable
 * JSON summary of the group list, not the array's own identity). Existing
 * per-group values a cashier has already typed (tip, service %, payment
 * method, room-charge selection) are preserved across a resync — only a
 * genuinely new group gets a fresh default entry.
 *
 * `Room` and `Tickets`/`Setup`/`Stock`/etc. tabs, the outlet/terminal
 * picker, multi-tab support, category+search filtering, sold-out display,
 * and void-with-reason are all real, pre-existing, tested capabilities —
 * restyled into the new dark panel, none removed.
 *
 * Bug fix (see `POSScreen`'s own header): every `Money` here used to
 * hardcode `currencyCode="NGN"` — `pos_menu_items`/`pos_orders` carry no
 * currency column of their own, so the real source of truth is the active
 * property's `base_currency`, now threaded in as a prop.
 *
 * Bug fix (this session's own "test and review Register" pass, live-
 * confirmed against the real dev backend): the settlement preview used to
 * omit tax entirely — see `fetchSettlementPreview`'s own header for the
 * full history, including the two further gaps a code-review pass caught
 * (a stale-response race and an empty-preview-response gap), both fixed
 * and covered by dedicated regression tests.
 */
export function RegisterTab({ activeProperty, isOffline = false, currentUserLabel }) {
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
  // The receipt snapshot shown after a successful checkout (see
  // `handleSubmitSettlement`) — `null` while selling.
  const [settleResult, setSettleResult] = useState(null);
  // `settlingRef` closes the same-tick double-click gap a state-only guard
  // can't; `settling` drives the disabled/"Settling…" button.
  const settlingRef = useRef(false);
  const [settling, setSettling] = useState(false);
  // What the checkout button says while a card/NQR payment is in progress.
  const [paymentStage, setPaymentStage] = useState(null);
  const [settlementForms, setSettlementForms] = useState(null);
  const [settlementPreview, setSettlementPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [voidingRow, setVoidingRow] = useState(null);
  // `{ order, itemCount }` while the "remove a tab that still has items"
  // confirmation is open; `removingTabId` disables that tab's ✕ while its
  // own check/void request is in flight.
  const [removingTab, setRemovingTab] = useState(null);
  const [removingTabId, setRemovingTabId] = useState(null);
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [openingTab, setOpeningTab] = useState(false);
  // `{ mode: 'new', value }` or `{ mode: 'rename', orderId, value }` while the tab-name dialog is open.
  const [tabNameDialog, setTabNameDialog] = useState(null);
  // Bug fix (code-review pass on the settlement-preview fix): a preview
  // fetch has no natural cancellation — a cashier can switch tabs (or an
  // item change can fire a new fetch) while a slow fetch is still in
  // flight, and its response used to land regardless, silently showing
  // one order's stale amount. This ref is bumped every time a preview
  // fetch starts or the active order changes; a response is only ever
  // applied if it's still current when it arrives — the same "ref-guarded
  // staleness check" pattern this codebase already uses for
  // `NewImportTab`'s identical race.
  const previewRequestIdRef = useRef(0);
  // Bug fix (code-review pass, high severity): `loadActiveOrder` had no
  // staleness guard at all, unlike the settlement-preview fetch above —
  // switching tabs quickly (or adding an item then switching away before
  // that add's own reload resolves) could let an OLDER order's response
  // land after a newer, already-correct one and silently clobber it,
  // reverting a correctly-loaded tab back to an empty/stale state with
  // nothing to self-heal it until another mutation was made. Same ref-
  // counter pattern as `previewRequestIdRef` above.
  const orderLoadRequestIdRef = useRef(0);
  // `handleGuestSearch`'s own staleness guard: `guestSearchGenerationRef`
  // is a SINGLE, global, never-reset counter (shared across every group on
  // every order) — deliberately not a per-group counter that restarts from
  // 1 each time, which a code-review pass caught as its own latent bug:
  // clearing a per-group counter back to a low number on a tab switch
  // means a brand-new search issued right after the switch could recompute
  // the exact same small id an old, already-invalidated search from the
  // PREVIOUS order had captured before the switch — a genuine, if narrow,
  // collision window. A monotonic, never-reused id closes that entirely.
  // `guestSearchLatestByGroupRef` (a `Map`, not a single ref, since two
  // groups can search independently at once inside the split-bill modal)
  // still tracks "the latest id for this group" — cleared on every order
  // change so a leftover value from the previous order can never be
  // mistaken for current even before any new search happens on the new
  // order.
  const guestSearchGenerationRef = useRef(0);
  const guestSearchLatestByGroupRef = useRef(new Map());

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
    setSettleResult(null);
    setOutletId(id);
    setTerminalId('');
    setActiveOrderId(null);
    setActiveOrder(null);
    setCategoryFilter('');
    setSearchQuery('');
    if (id) loadOutletContext(id);
  }

  async function loadActiveOrder(id) {
    const requestId = ++orderLoadRequestIdRef.current;
    try {
      const order = await posApi.getOrder(id);
      if (orderLoadRequestIdRef.current !== requestId) return; // superseded by a later load — never clobber a newer, already-correct order
      setActiveOrder(order);
    } catch (caught) {
      if (orderLoadRequestIdRef.current !== requestId) return;
      setError(caught instanceof ApiError ? caught.message : 'Could not load this tab.');
    }
  }

  /**
   * "+ New tab" asks the cashier what to call the tab (user-requested: a
   * proper name instead of an automatic "Table 1" — e.g. "Table 4",
   * "Pool bar – John", "Room 205"), pre-filled with the next "Table N" so
   * the common case is still one extra tap.
   */
  function handleNewTab() {
    if (openingTab) return;
    setSettleResult(null);
    if (!terminalId) {
      setError('Select a terminal first.');
      return;
    }
    setError(null);
    setTabNameDialog({ mode: 'new', value: `Table ${openOrders.length + 1}` });
  }

  async function submitTabName(event) {
    event.preventDefault();
    const name = tabNameDialog.value.trim();
    if (!name) return;
    if (tabNameDialog.mode === 'new') {
      setTabNameDialog(null);
      await openNamedTab(name);
      return;
    }
    const { orderId } = tabNameDialog;
    setTabNameDialog(null);
    try {
      const renamed = await posApi.renameOrder(orderId, name);
      setOpenOrders((prev) => prev.map((order) => (String(order.id) === String(orderId) ? { ...order, table_label: renamed.table_label } : order)));
      setActiveOrder((current) => (current && String(current.order.id) === String(orderId) ? { ...current, order: { ...current.order, table_label: renamed.table_label } } : current));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not rename this tab.');
    }
  }

  async function openNamedTab(tableLabel) {
    if (openingTab) return;
    setOpeningTab(true);
    try {
      // Reference-design fix: `tableLabel` was always sent blank, so every
      // tab showed as the generic "Tab #{id}" instead of the reference
      // screen's real "Table 1"/"Table 2" — a genuine, real backend field
      // (`openOrder` already accepts it) this screen simply never
      // populated. A running "Table N" default, numbered by however many
      // tabs are already open at this outlet, gives every new tab a real
      // label with no typing required for the common case.
      //
      // Bug fix (code-review pass, medium severity): `openOrders.length` is
      // read at call time, before the network round trip below — two rapid
      // "+ New tab" taps that both fire before either resolves would both
      // compute the SAME "Table N" (the button had no guard against
      // re-entry). The `openingTab` guard above disables the button for
      // the whole request, which prevents the double-tap outright rather
      // than just fixing the resulting label collision.
      const order = await posApi.openOrder({ outletId, terminalId, tableLabel });
      // Functional update (code-review fix) — closing over a stale
      // `openOrders` snapshot would let a concurrent update silently drop
      // this real, already-server-created order from the tab strip.
      setOpenOrders((prev) => [...prev, order]);
      setActiveOrderId(order.id);
      await loadActiveOrder(order.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open a new tab.');
    } finally {
      setOpeningTab(false);
    }
  }

  /**
   * User-reported: "+ New tab" had no counterpart — every tab ever opened at
   * an outlet stayed in the strip until settled, with no way to close one.
   * Removing a tab voids it (`POST /pos/orders/:id/void`, which already
   * existed and was wrapped in `posApi.voidOrder` but never called) — the
   * order row is kept, marked void with a reason, never deleted
   * (ARCHITECTURE.md §8). An empty tab closes immediately, since nothing
   * rung up can be lost; a tab that still has items asks for confirmation
   * and a reason first, recorded in the audit trail, so a served round
   * can't disappear in one click. Item counts come from a fresh `getOrder`,
   * not the tab strip's list row, which carries no items.
   */
  async function handleRemoveTab(order) {
    setError(null);
    setRemovingTabId(order.id);
    try {
      const detail = await posApi.getOrder(order.id);
      const itemCount = detail.items.filter((item) => !item.voided_at).length;
      if (itemCount === 0) {
        await closeTab(order, 'Empty tab removed from the Register');
      } else {
        setRemovingTab({ order, itemCount });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove this tab.');
    } finally {
      setRemovingTabId(null);
    }
  }

  async function confirmRemoveTab(reason) {
    const { order } = removingTab;
    setRemovingTab(null);
    setError(null);
    try {
      await closeTab(order, reason);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove this tab.');
    }
  }

  async function closeTab(order, reason) {
    await posApi.voidOrder(order.id, reason);
    setOpenOrders((prev) => prev.filter((open) => open.id !== order.id));
    if (String(activeOrderId) === String(order.id)) {
      // Discard any load still in flight for the tab that just closed, so
      // it can't land afterwards and redraw a voided tab's panel.
      orderLoadRequestIdRef.current += 1;
      setSplitModalOpen(false);
    }
    setActiveOrderId((current) => (String(current) === String(order.id) ? null : current));
    setActiveOrder((current) => (current && String(current.order.id) === String(order.id) ? null : current));
  }

  function switchToTab(order) {
    setSettleResult(null);
    setSplitModalOpen(false);
    setActiveOrderId(order.id);
    loadActiveOrder(order.id);
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

  /** `voidingRow.ids` is always an array — one id for the "−" stepper (void the most-recently-added unit) or the trash icon on a ×1 line, every row's id for the trash icon on a ×N line (voids the whole line at once). */
  /**
   * Bug fix (code-review pass, high severity): a real partial failure is
   * reachable here — voiding a whole ×N line issues N independent
   * `voidOrderItem` calls, each its own backend transaction, and a
   * concurrent terminal voiding one of the SAME rows a moment earlier
   * (`OrderItemAlreadyVoidedError`) makes one call fail while the others
   * genuinely succeed. The original `Promise.all` + reload-only-on-full-
   * success meant a partial failure left the ticket showing stale,
   * already-wrong quantities with no reload — and retrying re-sent the
   * SAME ids, permanently re-failing on the row that had already
   * succeeded, with no way to ever finish cleanly short of switching tabs
   * away and back. `Promise.allSettled` plus an unconditional reload means
   * the ticket always ends up showing reality, whatever actually happened
   * server-side; a real failure is still surfaced, but never leaves the
   * display stale.
   */
  async function confirmVoid(reason) {
    const { ids } = voidingRow;
    setVoidingRow(null);
    setError(null);
    const results = await Promise.allSettled(ids.map((id) => posApi.voidOrderItem(activeOrderId, id, reason)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      setError(failure.reason instanceof ApiError ? failure.reason.message : 'Could not void one or more items.');
    }
    await loadActiveOrder(activeOrderId);
  }

  async function handleAssignGroup(item, group) {
    try {
      await posApi.assignItemSplitGroup(activeOrderId, item.id, group);
      await loadActiveOrder(activeOrderId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not assign this item to a split group.');
    }
  }

  /**
   * Bug fix (this session's own "test and review Register" pass, live-
   * confirmed against the real dev backend): the settlement panel used to
   * show "Amount to charge" as `subtotal + tip + service charge` with NO
   * tax at all — a real ₦20.00 item with a real 7.5% VAT actually charges
   * ₦21.50, but the cashier only ever saw ₦20.00. Tax depends on live,
   * permission-gated config (`taxes`) this screen's own role (`pos_operator`)
   * cannot read directly (`GET /taxes` is `setup.view`-gated) — and this
   * codebase's own "money is exact, always, server-computed" rule
   * (ARCHITECTURE.md §12) rules out re-implementing the tax engine
   * client-side even if it could. Fixed with a `pos.operate`-gated,
   * read-only `GET /pos/orders/:id/settlement-preview` that reuses the
   * EXACT SAME tax computation `settleOrder` itself uses — never a second,
   * parallel algorithm. `settlementPreview` stays `null` (rendering
   * "Calculating…", never a guessed number) until a real result comes
   * back, and checkout stays disabled the whole time.
   *
   * Redesign follow-on: this now runs REACTIVELY (see the effect below
   * this function), not only once behind a separate "Settle" click, so
   * the always-visible ticket panel's totals stay live as items change.
   */
  async function fetchSettlementPreview(orderId) {
    const requestId = ++previewRequestIdRef.current;
    setSettlementPreview(null);
    setPreviewError(null);
    try {
      const preview = await posApi.getSettlementPreview(orderId);
      if (previewRequestIdRef.current !== requestId) return; // superseded — a later fetch started, or the order changed
      setSettlementPreview(preview.groups);
    } catch (caught) {
      if (previewRequestIdRef.current !== requestId) return;
      setPreviewError(caught instanceof ApiError ? caught.message : 'Could not compute the real settlement total.');
    }
  }

  /**
   * Bug fix (user-reported: "click checkout, it opens a blank page"): a
   * successful settle used to replace the ENTIRE Register — header, tab
   * strip and panel — with a tiny "Tab settled." line and a faint ghost
   * button, which read as a blank page. It now snapshots a receipt (items,
   * tender per check, exact totals) from the order state about to be
   * cleared, and `SettlementReceipt` shows it inside the panel while the
   * header and remaining tabs stay usable.
   *
   * Also fixed: no in-flight guard. A double-tap sent two settles with two
   * different Idempotency-Keys; the backend's row lock refused the second
   * with ORDER_NOT_OPEN, surfacing an error right after a checkout that had
   * actually succeeded.
   */
  async function handleSubmitSettlement(event) {
    event.preventDefault();
    if (settlingRef.current) return;
    settlingRef.current = true;
    setSettling(true);
    setError(null);
    try {
      // Card/NQR checks are paid through Paystack first, one at a time; the
      // tab only settles once every one of them has captured money.
      const paymentIds = new Map();
      for (const form of settlementForms) {
        if (form.method !== 'card') continue;
        const payment = await collectPaystackPayment(form);
        paymentIds.set(form.splitGroup, payment.id);
      }
      setPaymentStage('Settling…');
      const result = await posApi.settleOrder(
        activeOrderId,
        settlementForms.map((form) => ({
          splitGroup: form.splitGroup,
          method: form.method,
          paymentId: paymentIds.get(form.splitGroup),
          serviceCharge: serviceAmountForGroup(form.splitGroup) ?? ZERO,
          roomCharge:
            form.method === 'room_charge'
              ? { reservationId: form.roomChargeGuest?.reservationId, authMethod: form.authMethod, authReference: form.authReference }
              : undefined,
        }))
      );
      // Built before anything below clears the order it reads from.
      setSettleResult(buildReceipt(result));
      setSplitModalOpen(false);
      setSettlementForms(null);
      setSettlementPreview(null);
      setPreviewError(null);
      setOpenOrders((prev) => prev.filter((o) => o.id !== activeOrderId));
      setActiveOrderId(null);
      setActiveOrder(null);
    } catch (caught) {
      const readable = caught instanceof ApiError || caught instanceof PaymentNotCompletedError;
      setError(readable ? caught.message : 'Could not settle this tab.');
      // A card/NQR payment may have been captured even though settling
      // failed — reload so the tab shows it rather than a stale view.
      if (settlementForms.some((form) => form.method === 'card')) loadActiveOrder(activeOrderId);
    } finally {
      settlingRef.current = false;
      setSettling(false);
      setPaymentStage(null);
    }
  }

  /**
   * One check's Paystack payment: start (or reopen) checkout, show the
   * on-screen popup, then ask the server what really happened — the popup's
   * own callback is never trusted as proof of payment (ARCHITECTURE.md §7).
   * A payment the server already holds as captured (the guest paid, then the
   * browser closed before settling) is returned without a second popup.
   */
  async function collectPaystackPayment(form) {
    const tenderName = form.tenderLabel;
    setPaymentStage(`Opening ${tenderName} payment…`);
    const { payment, accessCode, checkoutError } = await posApi.startPaystackCheckout(activeOrderId, {
      splitGroup: form.splitGroup,
      tender: form.tender,
      customerEmail: form.customerEmail.trim(),
    });
    if (payment.status === 'CAPTURED') return payment;
    if (!accessCode) {
      // Paystack refuses a checkout whose only channel is switched off on
      // the merchant account — for NQR, the QR channel must be enabled in
      // the Paystack dashboard first.
      if (checkoutError?.includes('No active channel')) {
        throw new PaymentNotCompletedError(`${tenderName} payments are not enabled on this Paystack account yet. Enable the channel in the Paystack dashboard, or choose another way to pay.`);
      }
      throw new PaymentNotCompletedError(checkoutError ? `Could not open Paystack: ${checkoutError}` : 'Could not open the Paystack checkout. Try again.');
    }

    setPaymentStage(`Waiting for ${tenderName} payment…`);
    await new Promise((resolve, reject) => {
      // Paystack can fire more than one close callback; the first one wins.
      let done = false;
      openPaystackPopup({
        accessCode,
        onClose: () => {
          if (done) return;
          done = true;
          resolve();
        },
      }).catch(() => reject(new PaymentNotCompletedError('Could not load the Paystack payment window. Check the connection and try again.')));
    });

    setPaymentStage('Confirming payment…');
    const verified = await posApi.verifyPaystackPayment(activeOrderId, payment.id);
    if (verified.status === 'CAPTURED') return verified;
    throw new PaymentNotCompletedError(
      verified.status === 'FAILED'
        ? `The ${tenderName} payment failed. Try again or choose another way to pay.`
        : `The ${tenderName} payment was not completed. Tap checkout again to reopen it.`
    );
  }

  /** Receipt snapshot from the settle response plus the order/forms still in scope. Totals are exact decimal sums — never float arithmetic. The stored method for NQR is `card`, so the tender shown comes from the form's own label. */
  function buildReceipt(result) {
    const settlements = (result.settlements ?? []).map((settlement) => {
      const form = settlementForms.find((candidate) => candidate.splitGroup === settlement.split_group);
      const guest = settlement.method === 'room_charge' ? form?.roomChargeGuest : null;
      return {
        splitGroup: settlement.split_group,
        tenderLabel: TENDER_LABELS[settlement.tender] ?? form?.tenderLabel ?? settlement.method,
        roomNumber: guest?.roomNumber ?? null,
        guestName: guest ? `${guest.guestFirstName} ${guest.guestLastName}` : null,
        total: sumMoney([settlement.subtotal, settlement.tax_amount, settlement.tip_amount, settlement.service_charge]),
      };
    });
    const rows = result.settlements ?? [];
    return {
      orderId: activeOrder.order.id,
      tableLabel: activeOrder.order.table_label || `Tab #${activeOrder.order.id}`,
      propertyName: activeProperty.name ?? null,
      propertyLogoUrl: activeProperty.logo_url ?? null,
      propertyAddress: activeProperty.address ?? null,
      cashier: currentUserLabel ?? null,
      settledAt: new Date().toISOString(),
      subtotal: sumMoney(rows.map((row) => row.subtotal)),
      tax: sumMoney(rows.map((row) => row.tax_amount)),
      serviceCharge: sumMoney(rows.map((row) => row.service_charge)),
      tips: sumMoney(rows.map((row) => row.tip_amount)),
      currencyCode: activeProperty.base_currency,
      items: groupOrderItems(unvoidedItems).map((group) => ({
        key: `${group.menuItemId}:${group.splitGroup ?? 'none'}`,
        name: menuItemName(group.menuItemId),
        quantity: group.rows.reduce((sum, row) => sum + row.quantity, 0),
        unitPrice: group.rows[0].unit_price,
      })),
      settlements,
      grandTotal: sumMoney(settlements.map((settlement) => settlement.total)),
    };
  }

  /** Patches one settlement-form entry by its split-group key — every field below uses this instead of each repeating its own clone-and-map. */
  function patchSettlementForm(splitGroup, patch) {
    setSettlementForms((forms) => forms.map((form) => (form.splitGroup === splitGroup ? { ...form, ...patch } : form)));
  }

  /**
   * Bug fix (code-review pass, medium severity): had no staleness guard at
   * all — typing quickly (e.g. "2" -> "20" -> "204") fires three
   * overlapping lookups with no ordering protection, and a slower, earlier
   * response landing after a faster, later one could silently overwrite
   * the correct, just-applied results with stale ones. Keyed per split
   * group (not a single shared counter) since two groups can genuinely
   * search independently at once in the split-bill modal.
   */
  async function handleGuestSearch(splitGroup, query) {
    patchSettlementForm(splitGroup, { roomChargeQuery: query });
    if (!query) return;
    const requestId = ++guestSearchGenerationRef.current;
    guestSearchLatestByGroupRef.current.set(splitGroup, requestId);
    try {
      const results = await posApi.findInHouseForCharge(query);
      if (guestSearchLatestByGroupRef.current.get(splitGroup) !== requestId) return; // superseded by a later search for this same group (possibly on a different order — see this ref's own header)
      patchSettlementForm(splitGroup, { roomChargeResults: results });
    } catch {
      // Search is a convenience — a failed lookup just leaves the last-known result list.
    }
  }

  // Only ever true once the real order data for the CURRENTLY selected tab
  // has actually loaded — switching tabs updates `activeOrderId`
  // synchronously but `activeOrder` itself lands one tick later
  // (`loadActiveOrder`'s own async resolution), and a live, always-visible
  // total is exactly the kind of prominent display that must never show a
  // stale, still-loading tab's numbers during that gap.
  const orderLoaded = activeOrder && String(activeOrder.order.id) === String(activeOrderId);
  const unvoidedItems = orderLoaded ? activeOrder.items.filter((item) => !item.voided_at) : [];
  const distinctGroups = [...new Set(unvoidedItems.map((item) => item.split_group ?? null))];
  // Real, unambiguous flag for "has anyone actually started splitting this
  // tab" — deliberately not `distinctGroups.length > 1`, which would
  // silently flip back to the merged view the moment every remaining item
  // happens to share one group (e.g. everything moved into group 1).
  const anySplit = unvoidedItems.some((item) => item.split_group != null);
  // A stable summary of everything that can change the REAL, server-
  // computed subtotal/tax: which items exist, how many of each, and which
  // group each is in. Bug found by this file's own test suite, not by
  // inspection: an earlier draft keyed the reconcile/re-fetch effect below
  // on just `JSON.stringify(distinctGroups)` — the SET of distinct groups
  // — which stays `'[null]'` both before and after adding a second unit of
  // an item already in that group, so the effect never re-ran and the
  // "always-visible, live" ticket total silently went stale the moment a
  // quantity changed without also changing the group set. Keying on every
  // item's own (id, quantity, split_group) instead changes on every add/
  // void/split-group-assign, exactly the set of mutations that can move
  // the real total.
  const orderContentsKey = JSON.stringify(unvoidedItems.map((item) => [item.id, item.quantity, item.split_group ?? null]));

  /**
   * Redesign: `settlementForms` is no longer created by clicking a
   * separate "Settle" button — it's kept in sync with the order's own
   * real split groups automatically, so the always-visible ticket panel
   * always has something real to show. Reconciles rather than replaces:
   * a group that still exists keeps whatever the cashier already typed
   * into it (tip, service %, payment method, room-charge selection); only
   * a genuinely new group gets a fresh default. Re-fetches the real
   * preview whenever the order's real contents change — never on every
   * render, since `unvoidedItems`' own array identity is new each time
   * regardless of content (hence keying on `orderContentsKey` instead).
   */
  useEffect(() => {
    if (!orderLoaded) {
      // Bump the request-id guard explicitly here too, not only inside
      // `fetchSettlementPreview` — belt-and-braces so a preview fetch
      // issued for whichever order was active BEFORE this transition can
      // never be mistaken for current, even during the brief window where
      // `settlementForms` being cleared happens to make it moot today.
      previewRequestIdRef.current += 1;
      // Bug fix (code-review pass, high severity): `handleGuestSearch`'s
      // own staleness map was keyed only by splitGroup ('null', '1', '2',
      // '3') — never by order. Since the overwhelming common case is one
      // unsplit group (key: null) on EVERY tab, a slow room-charge search
      // left in flight on tab A could resolve after switching to tab B and
      // silently populate B's guest picker with A's search results — a
      // real risk of charging the wrong tab to the wrong guest's room.
      // Clearing the map here means a leftover value from the previous
      // order can never be mistaken for current on the new one; pairing
      // this with `guestSearchGenerationRef`'s own never-reset counter
      // (see that ref's header) also closes the narrower case where a
      // brand-new search right after this clear could otherwise recompute
      // the same small id an old, already-invalidated search had captured.
      guestSearchLatestByGroupRef.current.clear();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset when the active order changes; no data-fetching library exists yet to own this (same suppression this module's other tabs already use)
      setSettlementForms(null);
      setSettlementPreview(null);
      setPreviewError(null);
      return;
    }
    setSettlementForms((prev) => {
      const prevByGroup = new Map((prev ?? []).map((form) => [form.splitGroup, form]));
      return distinctGroups.map((group) => prevByGroup.get(group) ?? defaultSettlementForm(group));
    });
    if (distinctGroups.length > 0) fetchSettlementPreview(activeOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- orderContentsKey is the intentional, stable summary of unvoidedItems' real content; that array's own identity changes every render regardless of content
  }, [activeOrderId, orderLoaded, orderContentsKey]);

  /** The real, server-computed {subtotal, taxAmount} for one split group — `null` while still loading or after a failed fetch, never a client-side guess (see `fetchSettlementPreview`'s own header for why). */
  function previewForGroup(splitGroup) {
    return settlementPreview?.find((g) => g.splitGroup === splitGroup) ?? null;
  }

  /**
   * Bug fix (code-review pass): gating checkout on merely
   * `settlementPreview !== null` was wrong on its own — `[]` is a real,
   * reachable response (every item on the order voided from a concurrent
   * terminal, ARCHITECTURE.md §5's own named "POS tab edit" race) and is
   * still non-null. Requiring a real match for EVERY currently displayed
   * group is the correct condition.
   */
  function previewReadyFor(forms) {
    return forms !== null && forms.length > 0 && forms.every((form) => previewForGroup(form.splitGroup) !== null);
  }

  /** The real, fixed 7.5% service-charge amount for one group, computed against that group's own real, server-verified subtotal. Factored out (code-review fix) since this exact computation was being repeated at three separate call sites. */
  function serviceAmountForGroup(splitGroup) {
    const preview = previewForGroup(splitGroup);
    return preview ? percentOfMoney(preview.subtotal, SERVICE_CHARGE_PERCENT) : null;
  }

  function grandTotalFor(form) {
    const preview = previewForGroup(form.splitGroup);
    const serviceAmount = serviceAmountForGroup(form.splitGroup);
    if (!preview || serviceAmount === null) return null;
    return sumMoney([preview.subtotal, preview.taxAmount, serviceAmount]);
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

  const singleSettlementForm = settlementForms?.length === 1 ? settlementForms[0] : null;
  const capturedPayments = orderLoaded ? (activeOrder.registerPayments ?? []).filter((payment) => payment.status === 'CAPTURED') : [];
  const selectedTerminal = terminals.find((t) => t.id === terminalId);
  const selectedOutlet = (outlets ?? []).find((o) => o.id === outletId);

  return (
    <>
    {/* Everything on screen is hidden when printing; only the receipt below prints. */}
    <div className={`${formStyles.form} ${styles.noPrint}`}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Orders cannot be settled until connectivity returns.</p>}

      <>
          {/*
            Layout pass (user-reported): the outlet/terminal picker and the
            tab strip used to be two separate full-width rows above the
            panel, each pushing it further down. Folded into one slim,
            wrapping row instead — still real, functioning controls (a
            cashier still must pick a terminal before opening a tab), just
            compact rather than a full labeled-field layout. `aria-label`
            (not a wrapping `<label>` with visible text above the select)
            keeps the same accessible name a screen reader or `getByLabelText`
            test relies on, without the extra vertical space a visible label
            row would cost.
          */}
          <div className={styles.compactHeader}>
            {/*
              Every header control is disabled while a checkout is in flight
              (code-review fix): switching tabs, opening or removing one, or
              changing station mid-settle let the settle's success handler —
              which clears the active order and shows its receipt — land on
              top of whatever the cashier had moved on to.
            */}
            <select className={styles.compactSelect} aria-label="Outlet" value={outletId} onChange={(e) => handleSelectOutlet(e.target.value)} disabled={settling}>
              <option value="">Select an outlet</option>
              {(outlets ?? []).map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
            <select className={styles.compactSelect} aria-label="Terminal" value={terminalId} onChange={(e) => setTerminalId(e.target.value)} disabled={!outletId || settling}>
              <option value="">Select a terminal</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>
                  {terminal.device_ref}
                </option>
              ))}
            </select>

            {outletId && (
              <div className={styles.compactTabs}>
                {openOrders.map((order) => {
                  const label = order.table_label || `Tab #${order.id}`;
                  return (
                    // Two sibling buttons in one chip (never a button nested
                    // in a button): the label switches to the tab, the ✕
                    // removes it.
                    <span key={order.id} className={`${styles.tabChip} ${styles.tabGroup} ${activeOrderId === order.id ? styles.tabChipActive : ''}`.trim()}>
                      <button type="button" className={styles.tabLabelButton} onClick={() => switchToTab(order)} disabled={settling}>
                        {label}
                      </button>
                      <button
                        type="button"
                        className={styles.tabCloseButton}
                        onClick={() => handleRemoveTab(order)}
                        disabled={isOffline || settling || removingTabId === order.id}
                        aria-label={`Remove ${label}`}
                        title="Remove tab"
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
                <button type="button" className={styles.tabChip} onClick={handleNewTab} disabled={isOffline || openingTab || settling}>
                  + New tab
                </button>
              </div>
            )}
          </div>

          {settleResult ? (
            <SettlementReceipt
              receipt={settleResult}
              onNewSale={() => {
                setSettleResult(null);
                if (terminalId) handleNewTab();
              }}
            />
          ) : activeOrder && (
            <div className={styles.panel}>
              <nav className={styles.rail} aria-label="Menu categories">
                <button
                  type="button"
                  className={`${styles.railItem} ${categoryFilter === '' ? styles.railItemActive : ''}`.trim()}
                  onClick={() => setCategoryFilter('')}
                >
                  <AllCategoriesIcon />
                  <span>All</span>
                </button>
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`${styles.railItem} ${categoryFilter === category ? styles.railItemActive : ''}`.trim()}
                    onClick={() => setCategoryFilter(category)}
                  >
                    <CategoryIcon category={category} />
                    <span>{category}</span>
                  </button>
                ))}
              </nav>

              <div className={styles.menuColumn}>
                <div className={styles.menuColumnHeader}>
                  <div>
                    <h2 className={styles.menuColumnTitle}>{categoryFilter || 'All items'}</h2>
                    <p className={styles.menuColumnSubtitle}>
                      {activeOrder.order.table_label || `Tab #${activeOrder.order.id}`}
                      {selectedOutlet ? ` · ${selectedOutlet.name}` : ''}
                    </p>
                  </div>
                  <input
                    className={styles.searchInput}
                    type="search"
                    placeholder="Search the menu…"
                    aria-label="Search the menu"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className={styles.menuGrid}>
                  {filteredMenuItems.map((item) => (
                    <div key={item.id} className={`${styles.menuCard} ${!item.is_available ? styles.menuCardSoldOut : ''}`.trim()}>
                      {/* Decorative: the name right below already identifies the item. */}
                      {item.image_url && <img className={styles.menuCardImage} src={item.image_url} alt="" loading="lazy" />}
                      <span className={styles.menuCardName}>{item.name}</span>
                      <div className={styles.menuCardFooter}>
                        {item.is_available ? (
                          <span className={styles.menuCardPrice}>
                            <Money amount={item.price} currencyCode={activeProperty.base_currency} />
                          </span>
                        ) : (
                          <span className={styles.soldOutBadge}>Sold out</span>
                        )}
                        <button
                          type="button"
                          className={styles.addButton}
                          onClick={() => handleAddItem(item.id)}
                          disabled={isOffline || !item.is_available}
                          aria-label={`Add ${item.name}`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                  {filteredMenuItems.length === 0 && <p className={formStyles.disabledNotice}>No menu items match this search.</p>}
                </div>
              </div>

              <div className={styles.ticket} role="region" aria-label="Order ticket">
                <div className={styles.ticketHeader}>
                  <h2 className={styles.ticketTitle}>Order Ticket</h2>
                  <span className={styles.statusPill}>Open</span>
                </div>
                <p className={styles.ticketMeta}>
                  {currentUserLabel ? `Server: ${currentUserLabel}` : selectedTerminal?.device_ref || ''}
                  {' · '}
                  {activeOrder.order.table_label || `Tab #${activeOrder.order.id}`}
                  {' · '}
                  <button
                    type="button"
                    className={styles.renameLink}
                    onClick={() => setTabNameDialog({ mode: 'rename', orderId: activeOrder.order.id, value: activeOrder.order.table_label ?? '' })}
                    disabled={isOffline || settling}
                    aria-label={`Rename ${activeOrder.order.table_label || `Tab #${activeOrder.order.id}`}`}
                  >
                    Rename
                  </button>
                </p>

                <div className={styles.ticketLines}>
                  {groupOrderItems(unvoidedItems).map((group) => {
                    const lastRow = group.rows[group.rows.length - 1];
                    const quantity = group.rows.reduce((sum, row) => sum + row.quantity, 0);
                    return (
                      <div key={`${group.menuItemId}:${group.splitGroup ?? 'none'}`} className={styles.ticketLine}>
                        <div className={styles.ticketLineInfo}>
                          <span className={styles.ticketLineName}>{menuItemName(group.menuItemId)}</span>
                          <span className={styles.ticketLineUnitPrice}>
                            <Money amount={group.rows[0].unit_price} currencyCode={activeProperty.base_currency} /> × {quantity}
                          </span>
                        </div>
                        <div className={styles.ticketLineActions}>
                          <button
                            type="button"
                            className={styles.stepperButton}
                            onClick={() => setVoidingRow({ ids: [lastRow.id], name: menuItemName(group.menuItemId) })}
                            disabled={isOffline}
                            aria-label={`Remove one ${menuItemName(group.menuItemId)}`}
                          >
                            −
                          </button>
                          <span className={styles.stepperQuantity}>{quantity}</span>
                          <button type="button" className={styles.stepperButton} onClick={() => handleAddItem(group.menuItemId)} disabled={isOffline} aria-label={`Add another ${menuItemName(group.menuItemId)}`}>
                            +
                          </button>
                          <button
                            type="button"
                            className={styles.removeButton}
                            onClick={() => setVoidingRow({ ids: group.rows.map((row) => row.id), name: menuItemName(group.menuItemId) })}
                            disabled={isOffline}
                            aria-label={`Void ${menuItemName(group.menuItemId)}`}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {unvoidedItems.length === 0 && <p className={styles.ticketEmpty}>Tap a menu item to add it to this ticket.</p>}
                </div>

                {/* Bug fix (code-review pass, high severity, always reproducible
                    — not just a race): this used to render regardless of
                    `splitModalOpen`, so opening "Split bill" before any item
                    actually had a real group assigned (anySplit still false
                    at that point) left the inline checkout form — a second,
                    fully live, enabled "Send to Bar & Checkout" submit button
                    wired to the same handleSubmitSettlement — rendered in the
                    DOM underneath the modal overlay, hidden only by CSS
                    (position: fixed), reachable by keyboard/tab order. The
                    modal is now the sole rendered checkout UI while open. */}
                {capturedPayments.length > 0 && (
                  <p className={styles.capturedNotice} role="status">
                    Payment already received for this tab — checkout will use it instead of charging again.
                  </p>
                )}

                {unvoidedItems.length > 0 && !splitModalOpen && (
                  <>
                    {anySplit ? (
                      <div className={styles.splitSummary}>
                        <p>This tab is split into {distinctGroups.length} check{distinctGroups.length === 1 ? '' : 's'}.</p>
                        <button type="button" className={styles.manageSplitButton} onClick={() => setSplitModalOpen(true)} disabled={isOffline}>
                          Manage split &amp; checkout
                        </button>
                      </div>
                    ) : (
                      singleSettlementForm && (
                        <form onSubmit={handleSubmitSettlement} className={styles.checkoutForm}>
                          <PreviewErrorBanner message={previewError} onRetry={() => fetchSettlementPreview(activeOrderId)} />
                          <SettlementFields
                            form={singleSettlementForm}
                            preview={previewForGroup(singleSettlementForm.splitGroup)}
                            serviceAmount={serviceAmountForGroup(singleSettlementForm.splitGroup)}
                            grandTotal={grandTotalFor(singleSettlementForm)}
                            currencyCode={activeProperty.base_currency}
                            isOffline={isOffline}
                            onPatch={(patch) => patchSettlementForm(singleSettlementForm.splitGroup, patch)}
                            onGuestSearch={(query) => handleGuestSearch(singleSettlementForm.splitGroup, query)}
                          />
                          <div className={styles.checkoutActions}>
                            {unvoidedItems.length >= 2 && (
                              <button type="button" className={styles.splitLink} onClick={() => setSplitModalOpen(true)} disabled={isOffline}>
                                Split bill
                              </button>
                            )}
                            <button type="submit" className={styles.checkoutButton} disabled={isOffline || settling || !previewReadyFor(settlementForms)}>
                              {settling ? (paymentStage ?? 'Settling…') : 'Send to Bar & Checkout'}
                            </button>
                          </div>
                        </form>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {splitModalOpen && settlementForms && (
            <div className={styles.settlementOverlay} role="presentation" onClick={() => setSplitModalOpen(false)}>
              <form className={styles.settlementPanel} onSubmit={handleSubmitSettlement} onClick={(event) => event.stopPropagation()}>
                <h2 className={styles.settlementTitle}>Split this tab</h2>

                <div className={styles.splitItemList}>
                  {unvoidedItems.map((item) => (
                    <div key={item.id} className={styles.splitItemRow}>
                      <span>
                        {item.quantity}× {menuItemName(item.menu_item_id)}
                      </span>
                      <select
                        className={styles.darkSelect}
                        value={item.split_group ?? ''}
                        onChange={(e) => handleAssignGroup(item, e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">No group</option>
                        <option value="1">Group 1</option>
                        <option value="2">Group 2</option>
                        <option value="3">Group 3</option>
                      </select>
                    </div>
                  ))}
                </div>

                <PreviewErrorBanner message={previewError} onRetry={() => fetchSettlementPreview(activeOrderId)} />

                {settlementForms.map((form) => (
                  <div key={form.splitGroup ?? 'all'} className={styles.settlementGroup}>
                    <h3 className={styles.settlementGroupTitle}>{form.splitGroup ? `Group ${form.splitGroup}` : 'Ungrouped'}</h3>
                    <SettlementFields
                      form={form}
                      preview={previewForGroup(form.splitGroup)}
                      serviceAmount={serviceAmountForGroup(form.splitGroup)}
                      grandTotal={grandTotalFor(form)}
                      currencyCode={activeProperty.base_currency}
                      isOffline={isOffline}
                      onPatch={(patch) => patchSettlementForm(form.splitGroup, patch)}
                      onGuestSearch={(query) => handleGuestSearch(form.splitGroup, query)}
                    />
                  </div>
                ))}

                <div className={styles.modalActionsRow}>
                  <button type="submit" className={styles.confirmButton} disabled={isOffline || settling || !previewReadyFor(settlementForms)}>
                    {settling ? (paymentStage ?? 'Settling…') : 'Confirm settlement'}
                  </button>
                  <button type="button" className={styles.cancelButton} onClick={() => setSplitModalOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {tabNameDialog && (
            <div className={styles.settlementOverlay} role="presentation" onClick={() => setTabNameDialog(null)}>
              <form
                className={styles.settlementPanel}
                role="dialog"
                aria-modal="true"
                aria-labelledby="tab-name-title"
                onSubmit={submitTabName}
                onClick={(event) => event.stopPropagation()}
              >
                <h2 id="tab-name-title" className={styles.settlementTitle}>
                  {tabNameDialog.mode === 'new' ? 'Name this tab' : 'Rename tab'}
                </h2>
                <label className={formStyles.form}>
                  <span className={styles.fieldLabel}>Tab name</span>
                  <input
                    className={styles.darkInput}
                    value={tabNameDialog.value}
                    maxLength={60}
                    autoFocus
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setTabNameDialog({ ...tabNameDialog, value: event.target.value })}
                    placeholder="e.g. Table 4, Pool bar – John, Room 205"
                    required
                  />
                </label>
                <div className={styles.modalActionsRow}>
                  <button type="submit" className={styles.confirmButton} disabled={!tabNameDialog.value.trim()}>
                    {tabNameDialog.mode === 'new' ? 'Open tab' : 'Save name'}
                  </button>
                  <button type="button" className={styles.cancelButton} onClick={() => setTabNameDialog(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {removingTab && (
            <ConfirmDialog
              title="Remove tab"
              consequence={`"${removingTab.order.table_label || `Tab #${removingTab.order.id}`}" still has ${removingTab.itemCount} item${removingTab.itemCount === 1 ? '' : 's'} on it. Removing it voids the whole tab. This cannot be undone.`}
              requireReason
              confirmLabel="Remove tab"
              onConfirm={confirmRemoveTab}
              onCancel={() => setRemovingTab(null)}
            />
          )}

          {voidingRow && (
            <ConfirmDialog
              title="Void item"
              consequence={
                voidingRow.ids.length > 1
                  ? `This removes all ${voidingRow.ids.length} "${voidingRow.name}" from the tab. This cannot be undone.`
                  : `This removes one "${voidingRow.name}" from the tab. This cannot be undone.`
              }
              requireReason
              confirmLabel="Void"
              onConfirm={confirmVoid}
              onCancel={() => setVoidingRow(null)}
            />
          )}
      </>
    </div>
    {settleResult && <PrintableReceipt receipt={settleResult} />}
    </>
  );
}

/**
 * The paper receipt — an 80mm thermal-roll layout that is invisible on
 * screen and is the only thing on the page when printing (the browser's
 * print dialog sends it to the terminal's receipt printer). Built from the
 * same snapshot the on-screen receipt card uses, so the two never disagree.
 */
function PrintableReceipt({ receipt }) {
  const { currencyCode } = receipt;
  const settled = new Date(receipt.settledAt);
  const splitBill = receipt.settlements.length > 1;
  return (
    <div className={styles.printReceipt} data-testid="printable-receipt">
      {receipt.propertyLogoUrl && <img className={styles.printLogo} src={receipt.propertyLogoUrl} alt={receipt.propertyName ?? 'Logo'} />}
      {receipt.propertyName && <p className={styles.printTitle}>{receipt.propertyName}</p>}
      {receipt.propertyAddress && <p className={styles.printCentered}>{receipt.propertyAddress}</p>}
      <p className={styles.printCentered}>Receipt #{receipt.orderId}</p>
      <p className={styles.printCentered}>{settled.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <p className={styles.printRow}>
        <span>{receipt.tableLabel}</span>
        {receipt.cashier && <span>Served by {receipt.cashier}</span>}
      </p>

      <hr className={styles.printRule} />
      {receipt.items.map((item) => (
        <p key={item.key} className={styles.printRow}>
          <span>
            {item.quantity} × {item.name}
          </span>
          <Money amount={multiplyMoney(item.unitPrice, item.quantity)} currencyCode={currencyCode} />
        </p>
      ))}

      <hr className={styles.printRule} />
      <p className={styles.printRow}>
        <span>Subtotal</span>
        <Money amount={receipt.subtotal} currencyCode={currencyCode} />
      </p>
      {receipt.tax !== ZERO && (
        <p className={styles.printRow}>
          <span>Tax</span>
          <Money amount={receipt.tax} currencyCode={currencyCode} />
        </p>
      )}
      {receipt.serviceCharge !== ZERO && (
        <p className={styles.printRow}>
          <span>Service ({SERVICE_CHARGE_PERCENT}%)</span>
          <Money amount={receipt.serviceCharge} currencyCode={currencyCode} />
        </p>
      )}
      {receipt.tips !== ZERO && (
        <p className={styles.printRow}>
          <span>Tip</span>
          <Money amount={receipt.tips} currencyCode={currencyCode} />
        </p>
      )}
      <p className={`${styles.printRow} ${styles.printTotal}`}>
        <span>TOTAL</span>
        <Money amount={receipt.grandTotal} currencyCode={currencyCode} />
      </p>

      <hr className={styles.printRule} />
      {receipt.settlements.map((settlement) => (
        <p key={settlement.splitGroup ?? 'all'} className={styles.printRow}>
          <span>
            {splitBill ? `${settlement.splitGroup ? `Group ${settlement.splitGroup}` : 'Ungrouped'}: ` : ''}
            {settlement.tenderLabel}
            {settlement.roomNumber ? ` · Room ${settlement.roomNumber}` : ''}
            {settlement.guestName ? ` (${settlement.guestName})` : ''}
          </span>
          <Money amount={settlement.total} currencyCode={currencyCode} />
        </p>
      ))}

      <p className={styles.printCentered}>Thank you!</p>
    </div>
  );
}

const RECEIPT_PAGE_STYLE_ID = 'pos-receipt-page-size';
const RECEIPT_MARGIN_MM = 3;
const PX_PER_MM = 96 / 25.4;

/**
 * Sizes the printed page to the receipt: 80mm wide and exactly as long as
 * the receipt. Chromium ignores `size: 80mm auto`, and a fixed height would
 * feed blank roll after every sale, so the height is measured and written
 * as a real length before printing.
 */
function sizeReceiptPage() {
  const receipt = document.querySelector('[data-testid="printable-receipt"]');
  if (!receipt) return;
  const previous = receipt.style.cssText;
  receipt.style.cssText = 'display:block;position:absolute;left:-10000px;top:0;visibility:hidden;';
  const heightMm = Math.ceil(receipt.getBoundingClientRect().height / PX_PER_MM) + RECEIPT_MARGIN_MM * 2;
  receipt.style.cssText = previous;
  if (!heightMm || heightMm <= RECEIPT_MARGIN_MM * 2) return;

  let style = document.getElementById(RECEIPT_PAGE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = RECEIPT_PAGE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `@page receipt { size: 80mm ${heightMm}mm; margin: ${RECEIPT_MARGIN_MM}mm; }`;
}

/**
 * Opens the print dialog for the receipt. Guarded so an environment with no
 * print support (or a blocked dialog) never breaks the checkout flow.
 */
async function printReceipt() {
  try {
    await receiptImagesReady();
    sizeReceiptPage();
    if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
  } catch {
    // Printing is a convenience — the on-screen receipt still shows the sale.
  }
}

/**
 * Waits (briefly) for the receipt's logo to finish loading, so the first
 * receipt of a session never prints with a blank space where the logo goes.
 * Gives up after 2 seconds — a slow or missing logo must not hold up the sale.
 */
function receiptImagesReady() {
  const images = [...document.querySelectorAll('[data-testid="printable-receipt"] img')].filter((img) => !img.complete);
  if (images.length === 0) return Promise.resolve();
  const loaded = Promise.all(
    images.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))
  );
  return Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

/**
 * The confirmation shown after a successful checkout, inside the Register
 * area where the order panel was. Focus moves to its heading so a screen
 * reader announces the sale, and "New sale" is the one prominent action.
 */
function SettlementReceipt({ receipt, onNewSale }) {
  const headingRef = useRef(null);
  // A ref, not just the effect, so the receipt prints once even when React
  // runs mount effects twice (StrictMode in development) — found printing
  // twice when checked in a real browser.
  const autoPrintedRef = useRef(false);
  useEffect(() => {
    headingRef.current?.focus();
    // Prints once, as soon as the sale is confirmed; "Print receipt" reprints.
    if (!autoPrintedRef.current) {
      autoPrintedRef.current = true;
      printReceipt();
    }
  }, []);
  const splitBill = receipt.settlements.length > 1;
  return (
    <div className={styles.receiptPanel} role="region" aria-label="Sale receipt">
      <h2 ref={headingRef} tabIndex={-1} className={styles.receiptHeading}>
        Tab settled
      </h2>
      <p className={styles.receiptMeta}>{receipt.tableLabel}</p>

      <div className={styles.receiptLines}>
        {receipt.items.map((item) => (
          <div key={item.key} className={styles.settlementLine}>
            <span>
              {item.name} × {item.quantity}
            </span>
            <Money amount={multiplyMoney(item.unitPrice, item.quantity)} currencyCode={receipt.currencyCode} />
          </div>
        ))}
      </div>

      <div className={styles.receiptLines}>
        {receipt.settlements.map((settlement) => (
          <div key={settlement.splitGroup ?? 'all'} className={styles.settlementLine}>
            <span>
              {splitBill ? `${settlement.splitGroup ? `Group ${settlement.splitGroup}` : 'Ungrouped'} · ` : ''}
              Paid by {settlement.tenderLabel}
              {settlement.roomNumber ? ` · Room ${settlement.roomNumber}${settlement.guestName ? ` (${settlement.guestName})` : ''}` : ''}
            </span>
            <Money amount={settlement.total} currencyCode={receipt.currencyCode} />
          </div>
        ))}
      </div>

      <div className={`${styles.settlementLine} ${styles.settlementGrandTotal}`}>
        <span>Total paid</span>
        <Money amount={receipt.grandTotal} currencyCode={receipt.currencyCode} />
      </div>

      <button type="button" className={styles.printButton} onClick={printReceipt}>
        Print receipt
      </button>
      <button type="button" className={styles.newSaleButton} onClick={onNewSale}>
        New sale
      </button>
    </div>
  );
}

/** The real settlement-preview failure banner — identical between the inline checkout and the split modal (code-review fix: this was duplicated verbatim at both call sites). */
function PreviewErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <p role="alert" className={formStyles.errorBanner}>
      {message}{' '}
      <button type="button" className={formStyles.label} onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

/**
 * One settlement group's fields (subtotal/tax/service preview, grand total,
 * payment method, room-charge sub-form) — shared verbatim between the
 * single-group inline checkout and the multi-group split modal, so the two
 * paths can never drift apart. `serviceAmount` is computed once by the
 * caller (`serviceAmountForGroup`) rather than here — code-review fix: this
 * component, `grandTotalFor`, and `handleSubmitSettlement` were each
 * independently calling `percentOfMoney` on the same inputs.
 *
 * Layout pass (user-reported): no Tip input, no editable Service % input —
 * just Subtotal, (Tax when nonzero,) Service at the fixed
 * `SERVICE_CHARGE_PERCENT`, Total. See `defaultSettlementForm`'s own header
 * for why `form` still carries no `tipAmount` field at all rather than a
 * dead one nothing ever sets.
 */
function SettlementFields({ form, preview, serviceAmount, grandTotal, currencyCode, isOffline, onPatch, onGuestSearch }) {
  return (
    <>
      {preview ? (
        <>
          <div className={styles.settlementLine}>
            <span>Subtotal</span>
            <Money amount={preview.subtotal} currencyCode={currencyCode} />
          </div>
          {/* Tax is a real, always-computed value — never silently omitted
              the moment it's genuinely nonzero (the exact bug this file's
              own settlement-preview fix exists to close) — but hidden when
              it's exactly "0.00", matching the reference design's own clean
              look for the common no-tax case (this dev tenant has no tax
              configured at all). Service stays always visible — its
              percentage is fixed, not cashier-entered, so there's no
              "haven't typed it yet" state to hide behind. */}
          {preview.taxAmount !== ZERO && (
            <div className={styles.settlementLine}>
              <span>Tax</span>
              <Money amount={preview.taxAmount} currencyCode={currencyCode} />
            </div>
          )}
          <div className={styles.settlementLine}>
            <span>Service ({SERVICE_CHARGE_PERCENT}%)</span>
            <Money amount={serviceAmount} currencyCode={currencyCode} />
          </div>
        </>
      ) : (
        <p className={formStyles.disabledNotice}>Calculating subtotal and tax…</p>
      )}

      <div className={`${styles.settlementLine} ${styles.settlementGrandTotal}`}>
        <span>Total</span>
        {grandTotal !== null ? <Money amount={grandTotal} currencyCode={currencyCode} /> : <span>Calculating…</span>}
      </div>

      {/*
        Color-correction pass (user-reported): the 3 tender buttons carry
        "equal visual weight, no highlighted/primary state on any one of
        them" — the checkout button below is the screen's one and only
        emphasized control. The selection is still real (`onPatch` still
        fires, `form.tenderLabel` still drives what actually submits) —
        `aria-pressed` conveys it to assistive tech without a visual cue
        sighted users would otherwise see as a false "primary" affordance.
      */}
      <div className={styles.paymentMethodRow}>
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method.label}
            type="button"
            className={styles.paymentButton}
            aria-pressed={form.tenderLabel === method.label}
            onClick={() => onPatch({ method: method.value, tenderLabel: method.label, tender: method.tender })}
            disabled={isOffline}
          >
            <PaymentMethodIcon method={method.label} />
            <span>{method.label}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`${styles.roomChargeLink} ${form.method === 'room_charge' ? styles.roomChargeLinkActive : ''}`.trim()}
        onClick={() => onPatch({ method: 'room_charge', tenderLabel: 'Charge to room', tender: 'room_charge' })}
        disabled={isOffline}
      >
        Charge to room instead
      </button>

      {form.method === 'card' && (
        <input
          className={styles.darkInput}
          type="email"
          placeholder="Customer email for receipt (optional)"
          aria-label="Customer email for receipt"
          value={form.customerEmail}
          onChange={(e) => onPatch({ customerEmail: e.target.value })}
        />
      )}

      {form.method === 'room_charge' && (
        <div className={formStyles.form}>
          <input
            className={styles.darkInput}
            placeholder="Room number or guest name"
            value={form.roomChargeQuery}
            onChange={(e) => onGuestSearch(e.target.value)}
          />
          <select
            className={styles.darkSelect}
            value={form.roomChargeGuest?.reservationId ?? ''}
            onChange={(e) => {
              const guest = form.roomChargeResults?.find((g) => String(g.reservationId) === e.target.value);
              onPatch({ roomChargeGuest: guest });
            }}
            required
          >
            <option value="">Select guest</option>
            {(form.roomChargeResults ?? []).map((guest) => (
              <option key={guest.reservationId} value={guest.reservationId}>
                Room {guest.roomNumber} — {guest.guestFirstName} {guest.guestLastName}
              </option>
            ))}
          </select>
          <div className={formStyles.row}>
            <select className={styles.darkSelect} value={form.authMethod} onChange={(e) => onPatch({ authMethod: e.target.value })}>
              {AUTH_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <input
              className={styles.darkInput}
              placeholder="e.g. PIN entered"
              value={form.authReference}
              onChange={(e) => onPatch({ authReference: e.target.value })}
              required
            />
          </div>
        </div>
      )}
    </>
  );
}
