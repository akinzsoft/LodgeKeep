import { useEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, percentOfMoney } from '../../shared/money.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import { CategoryIcon, AllCategoriesIcon, PaymentMethodIcon, TrashIcon } from './registerCategoryIcons.jsx';
import formStyles from './POSForm.module.css';
import styles from './RegisterTab.module.css';

const AUTH_METHODS = [
  { value: 'signature', label: 'Signature' },
  { value: 'room_key', label: 'Room key presented' },
  { value: 'pin', label: 'PIN' },
];

// "NQR" (Nigerian instant-transfer QR) submits identically to "card" — this
// codebase's own migrations (`pos_order_settlements`, `payments`) already
// establish contactless/NQR as a HARDWARE fact about the terminal
// (`pos_terminals.supports_contactless`), never a separate settlement
// method, and Flutterwave (the gateway PRODUCT_REQUIREMENTS.md §3.5 names
// for real NQR processing) is deliberately unwired anywhere in this
// codebase — no sandbox credentials exist. Confirmed with the user before
// building: NQR is a visually distinct tender-type button, recorded the
// same way Card already is, not a live gateway integration.
// The three primary tender buttons the reference design shows in one row.
// "Charge to room" is real, tested, pre-existing functionality this
// redesign preserves rather than drops — kept reachable as its own smaller
// link below the row instead of a 4th equally-weighted button, matching
// the reference's own literal 3-button row exactly.
const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'card', label: 'NQR' },
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

function defaultSettlementForm(splitGroup) {
  return {
    splitGroup,
    method: 'cash',
    // `tenderLabel` tracks which of the 4 visual tender buttons is
    // highlighted, separately from `method` — "Card" and "NQR" both
    // submit `method: 'card'` (see `PAYMENT_METHODS`' own header), so
    // highlighting purely by `method` would light up both at once the
    // moment either was picked. `method` alone is still what actually
    // submits; `tenderLabel` is presentation-only.
    tenderLabel: 'Cash',
    tipAmount: ZERO,
    servicePercent: ZERO,
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
 * 1. **NQR/Flutterwave** — no real gateway integration exists anywhere in
 *    this codebase (confirmed by reading `payments`/`pos_order_settlements`
 *    migrations directly: Flutterwave has no sandbox credentials, and NQR
 *    has always been treated as a hardware fact about the terminal, not a
 *    payment method). NQR submits as `method: 'card'`, visually distinct —
 *    building a real Flutterwave adapter is a separate, much larger
 *    project than a Register redesign.
 * 2. **Split billing** — the mockup's single always-visible ticket has no
 *    room for the existing multi-group settlement flow. Kept, not
 *    dropped: a "Split bill" action opens the pre-existing (now restyled)
 *    multi-group overlay; the common, unsplit case settles inline in the
 *    ticket panel itself with no modal at all.
 * 3. **"Service %"** — this codebase's `serviceCharge` has always been a
 *    flat amount the cashier types; there was no percentage concept
 *    anywhere. The cashier now types a percent, computed against the
 *    real, server-verified subtotal via `percentOfMoney` (exact BigInt-
 *    cents arithmetic, `shared/money.js`) — the computed flat amount is
 *    what actually submits, so the backend contract is unchanged.
 * 4. **The Tax line** — the mockup's own totals list doesn't name it, but
 *    dropping it would silently reintroduce the exact bug this file's own
 *    settlement-preview fix (below) exists to close. Kept.
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
  const [settleResult, setSettleResult] = useState(null);
  const [settlementForms, setSettlementForms] = useState(null);
  const [settlementPreview, setSettlementPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [voidingRow, setVoidingRow] = useState(null);
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [openingTab, setOpeningTab] = useState(false);
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

  async function handleNewTab() {
    if (openingTab) return;
    if (!terminalId) {
      setError('Select a terminal first.');
      return;
    }
    setError(null);
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
      const order = await posApi.openOrder({ outletId, terminalId, tableLabel: `Table ${openOrders.length + 1}` });
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

  function switchToTab(order) {
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
          serviceCharge: serviceAmountForGroup(form.splitGroup, form.servicePercent) ?? ZERO,
          roomCharge:
            form.method === 'room_charge'
              ? { reservationId: form.roomChargeGuest?.reservationId, authMethod: form.authMethod, authReference: form.authReference }
              : undefined,
        }))
      );
      setSettleResult(result);
      setSplitModalOpen(false);
      setSettlementForms(null);
      setSettlementPreview(null);
      setPreviewError(null);
      setOpenOrders((prev) => prev.filter((o) => o.id !== activeOrderId));
      setActiveOrderId(null);
      setActiveOrder(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not settle this tab.');
    }
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

  /** The real service-charge amount for one group — `form.servicePercent` computed against that group's own real, server-verified subtotal. Factored out (code-review fix) since this exact computation was being repeated at three separate call sites. */
  function serviceAmountForGroup(splitGroup, servicePercent) {
    const preview = previewForGroup(splitGroup);
    return preview ? percentOfMoney(preview.subtotal, servicePercent) : null;
  }

  function grandTotalFor(form) {
    const preview = previewForGroup(form.splitGroup);
    const serviceAmount = serviceAmountForGroup(form.splitGroup, form.servicePercent);
    if (!preview || serviceAmount === null) return null;
    return sumMoney([preview.subtotal, preview.taxAmount, form.tipAmount || ZERO, serviceAmount]);
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
  const selectedTerminal = terminals.find((t) => t.id === terminalId);
  const selectedOutlet = (outlets ?? []).find((o) => o.id === outletId);

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
                  onClick={() => switchToTab(order)}
                >
                  {order.table_label || `Tab #${order.id}`}
                </button>
              ))}
              <button type="button" className={styles.tabChip} onClick={handleNewTab} disabled={isOffline || openingTab}>
                + New tab
              </button>
            </div>
          )}

          {activeOrder && (
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
                            serviceAmount={serviceAmountForGroup(singleSettlementForm.splitGroup, singleSettlementForm.servicePercent)}
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
                            <button type="submit" className={styles.checkoutButton} disabled={isOffline || !previewReadyFor(settlementForms)}>
                              Send to Bar &amp; Checkout
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
                      serviceAmount={serviceAmountForGroup(form.splitGroup, form.servicePercent)}
                      grandTotal={grandTotalFor(form)}
                      currencyCode={activeProperty.base_currency}
                      isOffline={isOffline}
                      onPatch={(patch) => patchSettlementForm(form.splitGroup, patch)}
                      onGuestSearch={(query) => handleGuestSearch(form.splitGroup, query)}
                    />
                  </div>
                ))}

                <div className={styles.modalActionsRow}>
                  <button type="submit" className={styles.confirmButton} disabled={isOffline || !previewReadyFor(settlementForms)}>
                    Confirm settlement
                  </button>
                  <button type="button" className={styles.cancelButton} onClick={() => setSplitModalOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
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
      )}
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
 * One settlement group's editable fields (subtotal/tax preview, tip,
 * service %, grand total, payment method, room-charge sub-form) — shared
 * verbatim between the single-group inline checkout and the multi-group
 * split modal, so the two paths can never drift apart. `serviceAmount` is
 * computed once by the caller (`serviceAmountForGroup`) rather than here —
 * code-review fix: this component, `grandTotalFor`, and `handleSubmitSettlement`
 * were each independently calling `percentOfMoney` on the same inputs.
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
          {/* Tax/Tip are real, always-computed values — never silently
              omitted the moment either is genuinely nonzero (the exact bug
              this file's own settlement-preview fix exists to close) — but
              hidden when they're exactly "0.00", matching the reference
              design's own clean look for the common no-tax/no-tip case
              (this dev tenant has no tax configured at all). Service stays
              always visible since it's the one line the cashier is
              actively editing via the input just below. */}
          {preview.taxAmount !== ZERO && (
            <div className={styles.settlementLine}>
              <span>Tax</span>
              <Money amount={preview.taxAmount} currencyCode={currencyCode} />
            </div>
          )}
          {/* Bug fix (code-review pass): `form.tipAmount` is raw, un-
              normalized text a cashier typed, unlike `preview.taxAmount`
              (always a server-formatted "X.XX" string) — a plain
              `!== ZERO` string comparison would spuriously show this line
              for "0", "0.0", or "00.00" (a cashier clearing the field back
              to zero rather than blanking it), even though the real value
              is zero. `Number(...)` is safe here specifically because
              this is a display-only zero CHECK, never an arithmetic
              operation on the value itself — the actual submitted/summed
              amount is always the exact original string. */}
          {Number(form.tipAmount || 0) !== 0 && (
            <div className={styles.settlementLine}>
              <span>Tip</span>
              <Money amount={form.tipAmount} currencyCode={currencyCode} />
            </div>
          )}
          <div className={styles.settlementLine}>
            <span>Service ({form.servicePercent || '0'}%)</span>
            <Money amount={serviceAmount} currencyCode={currencyCode} />
          </div>
        </>
      ) : (
        <p className={formStyles.disabledNotice}>Calculating subtotal and tax…</p>
      )}

      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={styles.fieldLabel}>Tip</span>
          <input
            className={styles.darkInput}
            type="number"
            step="0.01"
            min="0"
            value={form.tipAmount}
            onChange={(e) => onPatch({ tipAmount: e.target.value })}
          />
        </label>
        <label className={formStyles.field}>
          <span className={styles.fieldLabel}>Service %</span>
          <input
            className={styles.darkInput}
            type="number"
            step="0.1"
            min="0"
            max="100"
            value={form.servicePercent}
            onChange={(e) => onPatch({ servicePercent: e.target.value })}
          />
        </label>
      </div>

      <div className={`${styles.settlementLine} ${styles.settlementGrandTotal}`}>
        <span>Total</span>
        {grandTotal !== null ? <Money amount={grandTotal} currencyCode={currencyCode} /> : <span>Calculating…</span>}
      </div>

      <div className={styles.paymentMethodRow}>
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method.label}
            type="button"
            className={`${styles.paymentButton} ${form.tenderLabel === method.label ? styles.paymentButtonActive : ''}`.trim()}
            onClick={() => onPatch({ method: method.value, tenderLabel: method.label })}
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
        onClick={() => onPatch({ method: 'room_charge', tenderLabel: 'Charge to room' })}
        disabled={isOffline}
      >
        Charge to room instead
      </button>

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
