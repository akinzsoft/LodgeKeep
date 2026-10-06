'use strict';

/**
 * GOLDEN-OUTPUT regression suite for every HOTEL payment path.
 *
 * Purpose: pin, byte for byte, what the current code does for hotel money —
 * folio cash/Paystack payments (verify, webhook, a payment after a terminal
 * state, refunds), the POS Register (cash with tip and service charge,
 * external terminal with and without a recorded account, Paystack card and
 * NQR, split bills, charge-to-room, settlement voids and the refusal to void
 * a gateway-paid one, a gateway refund of a Register payment, a late capture
 * of a cancelled Register checkout), QR guest orders paid by card (and a paid
 * order rejected and refunded), front-desk checkout against the folio, the
 * payment reconciliation report and the POS Sales report (JSON and CSV) — so
 * that a later change elsewhere (a supermarket Paystack card flow) can prove
 * it changed none of it. Every scenario is captured as a NORMALIZED object
 * (API status + body, the database rows the flow wrote, the Paystack calls
 * made) and compared with `toMatchSnapshot()`.
 *
 * Normalization (see `Normalizer` below) keeps every amount, status, type,
 * tender, method, error code and message, tax line, channel, subaccount and
 * fee, and replaces only what legitimately differs from run to run:
 *   - database ids become `<table>#<rank>`, the rank being the row's position
 *     among this file's own rows of that table (rows created after the
 *     file's baseline, ordered by id) — the same in an isolated run and in the
 *     full suite, and independent of the order a response lists them in;
 *   - generated references (ULIDs) become `ref(payments#n)` /
 *     `folio(folios#n)` / `conf(reservations#n)`, or `<ulid>` otherwise;
 *   - timestamps become `<datetime>` (null stays null — set vs unset is
 *     behaviour); `request_id` is removed.
 * Business dates are fixed (property business date BUSINESS_DATE) and every
 * amount is fixed, so nothing depends on the wall clock.
 *
 * Paystack is mocked at its adapter boundary exactly as every other Paystack
 * suite does it (`resolveAdapterForCurrency` returns one fully-mocked
 * adapter); webhook signatures are mocked valid, as in
 * tests/cashiering/cashiering.test.js and webhook-verification.test.js.
 *
 * Ambient tax: the fixture seeds a 7.5% VAT (`applies_to: 'all'`) on
 * ctx.a's property; it applies to room charges and POS sales alike.
 *
 * Updating the snapshot is a DELIBERATE act: only when a hotel payment
 * behaviour change was intended. A diff here from an unrelated change is
 * exactly the regression this file exists to catch.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    createSubaccount: jest.fn(),
    resolveBankAccount: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { parse: parseCsv } = require('csv-parse/sync');
const { compareMoney } = require('../../src/shared/money');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { insertMenuItem } = require('../helpers/catalogue');
const { gatewayRecordFor, recordForStoredPayment } = require('../helpers/gateway-record');
const { signAccessToken } = require('../../src/auth/tokens');
const { hashPassword } = require('../../src/auth/password');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const { rateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

const paystack = paystackAdapterModule.__mockAdapter;

const BUSINESS_DATE = '2027-08-10';
const FEE_PERCENTAGE = '2.50';

/** Tables whose ids are labelled by rank. Order is irrelevant; a missing table is skipped. */
const RANKED_TABLES = [
  'tenants',
  'properties',
  'users',
  'guests',
  'room_types',
  'rooms',
  'rate_codes',
  'taxes',
  'reservations',
  'reservation_rooms',
  'folios',
  'folio_line_items',
  'payments',
  'payment_webhook_events',
  'pos_outlets',
  'pos_terminals',
  'pos_menu_categories',
  'pos_menu_items',
  'pos_orders',
  'pos_order_items',
  'pos_order_settlements',
  'pos_guest_orders',
  'pos_order_tokens',
  'pos_outlet_terminal_accounts',
  'pos_outlet_payment_subaccounts',
  'property_payment_subaccounts',
  'platform_payment_integrations',
  'pos_shifts',
  'audit_log',
  'in_app_notifications',
];

/** Which table a foreign-key-ish property name refers to. First match wins. */
const KEY_KIND_RULES = [
  [/^tenant_?id$/i, 'tenants'],
  [/^property_?id$/i, 'properties'],
  [/user_?id$/i, 'users'],
  [/terminal_?account_?id$/i, 'pos_outlet_terminal_accounts'],
  [/payment_?subaccount_?id$/i, 'property_payment_subaccounts'],
  [/platform_?payment_?integration_?id$/i, 'platform_payment_integrations'],
  [/guest_?order_?id$/i, 'pos_guest_orders'],
  [/payment_?id$/i, 'payments'],
  [/^(webhook_?)?event_?id$/i, 'payment_webhook_events'],
  [/folio_?id$/i, 'folios'],
  [/order_?item_?id$/i, 'pos_order_items'],
  [/line_?item_?id$/i, 'folio_line_items'],
  [/order_?id$/i, 'pos_orders'],
  [/settlement_?id$/i, 'pos_order_settlements'],
  [/reservation_?id$/i, 'reservations'],
  [/guest_?id$/i, 'guests'],
  [/outlet_?id$/i, 'pos_outlets'],
  [/terminal_?id$/i, 'pos_terminals'],
  [/menu_?item_?id$/i, 'pos_menu_items'],
  [/category_?id$/i, 'pos_menu_categories'],
  [/room_?type_?id$/i, 'room_types'],
  [/room_?id$/i, 'rooms'],
  [/rate_?code_?id$/i, 'rate_codes'],
  [/tax_?id$/i, 'taxes'],
  [/shift_?id$/i, 'pos_shifts'],
  [/token_?id$/i, 'pos_order_tokens'],
];

/** Property names ending in id/Id that are NOT database ids — kept verbatim (the test controls their values). */
const VERBATIM_KEYS = new Set(['provider_event_id', 'providerEventId', 'provider_payment_id', 'providerPaymentId']);

/** For an `id` property, which table it belongs to, judged by the key of the object holding it. */
const PARENT_KIND = {
  settlements: 'pos_order_settlements',
  settlement: 'pos_order_settlements',
  order: 'pos_orders',
  orders: 'pos_orders',
  tabs: 'pos_orders',
  items: 'pos_order_items',
  payment: 'payments',
  payments: 'payments',
  registerPayments: 'payments',
  refund: 'payments',
  guestOrder: 'pos_guest_orders',
  reservation: 'reservations',
  folio: 'folios',
  folios: 'folios',
  lineItems: 'folio_line_items',
  line_items: 'folio_line_items',
  taxLines: 'folio_line_items',
  // A webhook payload's `data.id` is the provider's event id, which the test controls.
  payload: 'verbatim',
};

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
/** A database id quoted inside human text ("refund payment 10 instead"), by the noun before it. */
const TEXT_ID_RE = /\b(payment|order|settlement|folio|reservation|tab|line item)\s+(\d+)\b/gi;
const TEXT_ID_KIND = { payment: 'payments', order: 'pos_orders', tab: 'pos_orders', settlement: 'pos_order_settlements', folio: 'folios', reservation: 'reservations', 'line item': 'folio_line_items' };
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/g;
const INTEGER_RE = /^\d+$/;
const JS_DATE_STRING_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT/;

describe('Golden output — every hotel payment path', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerId;
  let managerToken;
  const baselines = {};

  // ------------------------------------------------------------------
  // Normalizer
  // ------------------------------------------------------------------

  const labels = {}; // kind -> Map(rawId -> label)
  const refLabels = new Map(); // generated string -> label
  const generic = {}; // unknown kind -> Map(raw -> label), labelled by appearance (should stay empty)

  async function syncTable(table) {
    if (!(table in baselines)) return;
    if (!labels[table]) labels[table] = new Map();
    const map = labels[table];
    let columns = ['id'];
    if (table === 'payments') columns = ['id', 'provider_reference'];
    if (table === 'folios') columns = ['id', 'folio_number'];
    if (table === 'reservations') columns = ['id', 'confirmation_number'];
    const rows = await t.trx(table).where('id', '>', baselines[table]).orderBy('id').select(columns);
    for (const row of rows) {
      const key = String(row.id);
      if (!map.has(key)) map.set(key, `${table}#${map.size + 1}`);
      const label = map.get(key);
      if (row.provider_reference) refLabels.set(row.provider_reference, `ref(${label})`);
      if (row.folio_number) refLabels.set(row.folio_number, `folio(${label})`);
      if (row.confirmation_number) refLabels.set(row.confirmation_number, `conf(${label})`);
    }
  }

  async function syncAll() {
    for (const table of Object.keys(baselines)) await syncTable(table);
  }

  function idLabel(kind, raw) {
    const key = String(raw);
    if (labels[kind]?.has(key)) return labels[kind].get(key);
    if (kind in baselines) {
      // Pre-baseline rows (should not occur) — still never the raw id.
      return `${kind}#pre`;
    }
    if (!generic[kind]) generic[kind] = new Map();
    if (!generic[kind].has(key)) generic[kind].set(key, `${kind}#g${generic[kind].size + 1}`);
    return generic[kind].get(key);
  }

  function kindForKey(key) {
    if (VERBATIM_KEYS.has(key)) return null;
    for (const [re, kind] of KEY_KIND_RULES) if (re.test(key)) return kind;
    if (/(_id|Id)$/.test(key)) return `key:${key}`;
    return null;
  }

  function normString(value) {
    if (refLabels.has(value)) return refLabels.get(value);
    if (DATETIME_RE.test(value) || JS_DATE_STRING_RE.test(value)) return '<datetime>';
    return value
      .replace(ULID_RE, (match) => refLabels.get(match) ?? '<ulid>')
      .replace(TEXT_ID_RE, (match, noun, raw) => `${noun} ${idLabel(TEXT_ID_KIND[noun.toLowerCase()], raw)}`);
  }

  function isIdValue(value) {
    return (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && INTEGER_RE.test(value));
  }

  function normScalar(key, value, idKind) {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return '<datetime>';
    if (key === 'id' && idKind === 'verbatim') return value;
    if (key === 'id' && idKind && isIdValue(value)) return idLabel(idKind, value);
    if (key === 'id' && isIdValue(value)) return idLabel('id:unknown', value);
    const kind = key ? kindForKey(key) : null;
    if (kind && isIdValue(value)) return idLabel(kind, value);
    if (/idempotency_?key/i.test(key ?? '')) return '<idempotency-key>';
    if (typeof value === 'string') return normString(value);
    return value;
  }

  /** Recursively normalizes a value. `idKind` names the table of an `id` property at this level. */
  function norm(value, idKind = null, key = null) {
    if (value && value.__golden === 'response') return { status: value.status, body: norm(value.body, value.idKind) };
    if (value && value.__golden === 'rows') return norm(value.rows, value.table);
    if (Array.isArray(value)) return value.map((item) => norm(item, idKind, key));
    if (value instanceof Date) return '<datetime>';
    if (value && typeof value === 'object') {
      const out = {};
      const entityKind = typeof value.entity_type === 'string' ? value.entity_type : null;
      for (const [k, v] of Object.entries(value)) {
        if (k === 'request_id' || k === 'requestId') continue;
        if (k === 'entity_id' && entityKind && isIdValue(v)) {
          out[k] = idLabel(entityKind, v);
          continue;
        }
        if (v && typeof v === 'object' && !(v instanceof Date) && entityKind && (k === 'after_state' || k === 'before_state')) {
          out[k] = norm(v, entityKind, k);
        } else if (v && typeof v === 'object' && !(v instanceof Date)) {
          out[k] = norm(v, PARENT_KIND[k] ?? (k === 'data' ? idKind : `id:${k}`), k);
        } else {
          out[k] = normScalar(k, v, idKind);
        }
      }
      return out;
    }
    return normScalar(key, value, idKind);
  }

  /**
   * Normalizes an array the server already orders, canonicalizing only TIES:
   * items are ordered by the server's own primary key (`primary`, a
   * comparator), and items it considers equal (same gross, same business date,
   * timestamps within one second...) by their normalized JSON. So a change to
   * the server's ordering still shows, while a coin-flip between two
   * same-second rows never does.
   */
  function tieSorted(array, idKind = null, primary = () => 0) {
    return norm(array, idKind)
      .map((item) => ({ item, json: JSON.stringify(item) }))
      .sort((a, b) => primary(a.item, b.item) || (a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
      .map(({ item }) => item);
  }
  const grossDesc = (a, b) => compareMoney(b.grossTotal, a.grossTotal);
  const businessDateDesc = (a, b) => (a.businessDate === b.businessDate ? 0 : a.businessDate < b.businessDate ? 1 : -1);

  /**
   * Captures are TAGGED raw values, normalized only at the end of the scenario
   * (in `golden`), after every row the scenario wrote has its label.
   */
  function response(res, idKind = null) {
    return { __golden: 'response', status: res.status, body: res.body, idKind };
  }

  /** A CSV body: header kept, every cell normalized by its column name, data rows sorted. */
  function csv(res) {
    const rows = parseCsv(res.text, { relax_column_count: true });
    const [header = [], ...data] = rows;
    const normalized = data.map((row) => row.map((cell, i) => {
      const column = header[i];
      if (cell === '') return cell;
      const kind = column === 'id' ? 'id:csv' : kindForKey(column);
      if (kind && INTEGER_RE.test(cell)) return idLabel(kind, cell);
      // A timestamp column (the reconciliation CSV writes JS Date#toString(), e.g. "Sun Oct 04 2026 23:57:19 GMT+0100 (...)").
      if (/(At|_at)$/.test(column ?? '') || JS_DATE_STRING_RE.test(cell)) return '<datetime>';
      return normString(cell);
    }));
    normalized.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return { status: res.status, contentType: res.headers['content-type'], header, rows: normalized };
  }

  async function dbRows(table, where, { orderBy = 'id', whereIn } = {}) {
    let query = t.trx(table).where(where);
    if (whereIn) query = query.whereIn(whereIn[0], whereIn[1]);
    const rows = await query.orderBy(orderBy);
    return { __golden: 'rows', rows, table };
  }

  /** audit_log action trail for the given entities, in write order. */
  async function auditTrail(entities) {
    const rows = [];
    for (const [entityType, ids] of Object.entries(entities)) {
      const clean = ids.filter((id) => id !== null && id !== undefined).map(String);
      if (clean.length === 0) continue;
      const found = await t.trx('audit_log').where({ entity_type: entityType }).whereIn('entity_id', clean).orderBy('id').select('id', 'entity_type', 'entity_id', 'action', 'source', 'reason', 'after_state');
      rows.push(...found);
    }
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    return rows.map(({ id: _id, ...rest }) => rest);
  }

  function paystackCalls() {
    return {
      initializeTransaction: paystack.initializeTransaction.mock.calls.map(([args]) => args),
      verifyTransaction: paystack.verifyTransaction.mock.calls.map(([args]) => args),
      refundTransaction: paystack.refundTransaction.mock.calls.map(([args]) => args),
    };
  }

  /** Builds the snapshot object: syncs every id label first so labels never depend on output order. */
  async function golden(build) {
    await syncAll();
    const value = norm(await build());
    expect(generic).toEqual({}); // every id met was a known table — nothing labelled by appearance
    return value;
  }

  // ------------------------------------------------------------------
  // Request helpers
  // ------------------------------------------------------------------

  let idem = 0;
  const idemKey = () => `golden-${(idem += 1)}`;
  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const get = (url) => t.request.get(url).set('Authorization', `Bearer ${managerToken}`);
  const post = (url, { idempotent = true } = {}) => {
    const req = t.request.post(url).set('Authorization', `Bearer ${managerToken}`);
    return idempotent ? req.set('Idempotency-Key', idemKey()) : req;
  };

  function initMock(accessCode) {
    paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({
      authorizationUrl: `https://paystack.test/pay/${accessCode}`,
      accessCode,
      reference,
    }));
  }

  let folioCounter = 0;
  async function openFolio(reservationId) {
    folioCounter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      reservation_id: reservationId ?? ctx.a.reservations[0].id,
      folio_number: `GOLDEN${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Golden Guest',
    });
    return id;
  }

  async function postWebhook(payment, eventId, event = 'charge.success') {
    paystack.verifyWebhookSignature.mockReturnValue(true);
    return t.request
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'mocked-valid')
      .send({ event, data: { id: eventId, reference: payment.provider_reference, status: 'success' } });
  }

  // Register outlet (the fixture bar: it records a GTBank terminal account).
  let register;

  async function openTab(label, items) {
    const opened = await post('/api/v1/pos/orders', { idempotent: false }).send({ outlet_id: register.outletId, terminal_id: register.terminalId, table_label: label });
    expect(opened.status).toBe(201);
    let last = opened;
    for (const [menuItemId, quantity] of items) {
      last = await post(`/api/v1/pos/orders/${opened.body.data.id}/items`, { idempotent: false }).send({ menu_item_id: menuItemId, quantity });
      expect(last.status).toBe(200);
    }
    return { orderId: opened.body.data.id, opened, last };
  }

  const settle = (orderId, settlements) => post(`/api/v1/pos/orders/${orderId}/settle`).send({ settlements });

  // A void or refund of a Register payment needs a manager's PIN approval (src/modules/approvals). The manager
  // approves their own action here; the approval rows live outside every snapshotted table and entity type.
  const GOLDEN_PIN = '482915';
  async function approval(action, targetId) {
    const res = await post('/api/v1/approvals', { idempotent: false }).send({ action, approver_user_id: managerId, pin: GOLDEN_PIN, reason: 'Golden approval', target_id: targetId });
    expect(res.status).toBe(201);
    return res.body.data.token;
  }
  const preview = (orderId) => get(`/api/v1/pos/orders/${orderId}/settlement-preview`);

  async function posState(orderId) {
    return {
      order: await dbRows('pos_orders', { id: orderId }),
      items: await dbRows('pos_order_items', { pos_order_id: orderId }),
      settlements: await dbRows('pos_order_settlements', { pos_order_id: orderId }),
      payments: await dbRows('payments', { pos_order_id: orderId }),
    };
  }

  async function folioState(folioId) {
    return {
      folio: await dbRows('folios', { id: folioId }),
      lines: await dbRows('folio_line_items', { folio_id: folioId }),
      payments: await dbRows('payments', { folio_id: folioId }),
    };
  }

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  beforeAll(async () => {
    for (const table of RANKED_TABLES) {
      try {
        const row = await t.trx(table).max({ max: 'id' }).first();
        baselines[table] = Number(row?.max ?? 0);
      } catch {
        // table not present in this schema — never labelled
      }
    }

    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    managerId = ctx.a.users[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: BUSINESS_DATE });
    await t.trx('property_payment_subaccounts').where({ tenant_id: ctx.a.id, property_id: propertyId }).update({ percentage_charge: FEE_PERCENTAGE });
    await setRole(managerId, 'manager');
    await t.trx('users').where({ id: managerId }).update({ first_name: 'Golden', last_name: 'Manager' });
    await t.trx('approval_pins').where({ tenant_id: ctx.a.id, user_id: managerId }).update({ pin_hash: await hashPassword(GOLDEN_PIN) });
    managerToken = tokenFor(managerId);

    const outletId = ctx.a.posOutlets[0].id;
    const terminalId = ctx.a.posTerminals[0].id;
    const [beerId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Golden Beer', category: 'Drinks', price: '20.00' });
    const [wineId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Golden Wine', category: 'Drinks', price: '35.00' });
    register = { outletId, terminalId, beerId, wineId, terminalAccountId: ctx.a.posOutletTerminalAccounts[0].id };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paystack.initializeTransaction.mockReset();
    paystack.verifyTransaction.mockReset();
    paystack.refundTransaction.mockReset();
    paystack.verifyWebhookSignature.mockReset();
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
  });

  // ==================================================================
  // 1. Folio payments
  // ==================================================================

  describe('1. folio: charges, cash, Paystack verify / webhook / after-terminal, refunds', () => {
    it('room charge → partial cash → Paystack verify captures the rest → refunds (cash partial, Paystack full)', async () => {
      const folioId = await openFolio();
      const charge = await post(`/api/v1/cashiering/folios/${folioId}/charges`).send({ type: 'room_charge', description: 'Room 101 — night of 2027-08-10', amount: '100.00' });
      const cash = await post(`/api/v1/cashiering/folios/${folioId}/payments/cash`).send({ amount: '50.00', currency: 'NGN' });
      const afterCash = await folioState(folioId);

      initMock('golden-folio-1');
      const init = await post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`).send({ amount: '57.50', currency: 'NGN', guest_email: 'golden.guest@example.com' });
      const paystackPaymentId = init.body.data.id;
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_golden_folio_1', channel: 'card' }));
      const verify = await post(`/api/v1/cashiering/payments/${paystackPaymentId}/verify`).send({});
      const afterVerify = await folioState(folioId);

      const cashRefund = await post(`/api/v1/cashiering/payments/${cash.body.data.id}/refund`).send({ amount: '10.00', reason: 'Golden partial cash refund' });
      paystack.refundTransaction.mockImplementation(async ({ reference }) => ({ status: 'processed', reference }));
      const paystackRefund = await post(`/api/v1/cashiering/payments/${paystackPaymentId}/refund`).send({ reason: 'Golden full Paystack refund' });

      const snapshot = await golden(async () => ({
        charge: response(charge, 'folio_line_items'),
        cash: response(cash, 'payments'),
        afterCash,
        paystackInit: response(init, 'payments'),
        paystackVerify: response(verify, 'payments'),
        afterVerify,
        cashRefund: response(cashRefund, 'payments'),
        paystackRefund: response(paystackRefund, 'payments'),
        final: await folioState(folioId),
        refundRows: await dbRows('payments', {}, { whereIn: ['parent_payment_id', [cash.body.data.id, paystackPaymentId]] }),
        audit: await auditTrail({
          payments: [cash.body.data.id, paystackPaymentId, cashRefund.body.data?.id, paystackRefund.body.data?.id],
          folio_line_items: [charge.body.data?.id],
          folios: [folioId],
        }),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('Paystack payment captured through a signed webhook (verified against the record), redelivery deduplicated', async () => {
      const folioId = await openFolio();
      const charge = await post(`/api/v1/cashiering/folios/${folioId}/charges`).send({ type: 'room_charge', description: 'Room 102', amount: '40.00' });
      initMock('golden-folio-2');
      const init = await post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`).send({ amount: '43.00', currency: 'NGN', guest_email: 'golden.guest@example.com' });
      const stored = await t.trx('payments').where({ id: init.body.data.id }).first();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(stored, { providerPaymentId: '91001', channel: 'bank_transfer' }));

      const first = await postWebhook(stored, 91001);
      const redelivery = await postWebhook(stored, 91001);

      const snapshot = await golden(async () => ({
        charge: response(charge, 'folio_line_items'),
        init: response(init, 'payments'),
        webhook: { status: first.status, body: norm(first.body) },
        redelivery: { status: redelivery.status, body: norm(redelivery.body) },
        events: await dbRows('payment_webhook_events', { provider_event_id: '91001' }),
        state: await folioState(folioId),
        audit: await auditTrail({ payments: [init.body.data.id] }),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('a payment Paystack captures after the local one FAILED is flagged needs_review and the ledger is untouched', async () => {
      const folioId = await openFolio();
      await post(`/api/v1/cashiering/folios/${folioId}/charges`).send({ type: 'room_charge', description: 'Room 103', amount: '20.00' });
      initMock('golden-folio-3');
      const init = await post(`/api/v1/cashiering/folios/${folioId}/payments/paystack`).send({ amount: '21.50', currency: 'NGN', guest_email: 'golden.guest@example.com' });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'failed', providerPaymentId: 'ps_golden_folio_3' }));
      const failedVerify = await post(`/api/v1/cashiering/payments/${init.body.data.id}/verify`).send({});

      const stored = await t.trx('payments').where({ id: init.body.data.id }).first();
      paystack.verifyTransaction.mockReset();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(stored, { providerPaymentId: '91002' }));
      const late = await postWebhook(stored, 91002);

      const snapshot = await golden(async () => ({
        failedVerify: response(failedVerify, 'payments'),
        lateWebhook: { status: late.status, body: norm(late.body) },
        events: await dbRows('payment_webhook_events', { provider_event_id: '91002' }),
        state: await folioState(folioId),
        audit: await auditTrail({ payments: [init.body.data.id] }),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('refuses a refund above the captured amount, and a direct void of a payment line', async () => {
      const folioId = await openFolio();
      await post(`/api/v1/cashiering/folios/${folioId}/charges`).send({ type: 'room_charge', description: 'Room 104', amount: '30.00' });
      const cash = await post(`/api/v1/cashiering/folios/${folioId}/payments/cash`).send({ amount: '32.25', currency: 'NGN' });
      const tooMuch = await post(`/api/v1/cashiering/payments/${cash.body.data.id}/refund`).send({ amount: '100.00', reason: 'Too much' });
      const paymentLine = await t.trx('folio_line_items').where({ payment_id: cash.body.data.id }).first();
      const voidPayment = await post(`/api/v1/cashiering/line-items/${paymentLine.id}/void`).send({ reason: 'Not allowed' });

      const snapshot = await golden(async () => ({
        cash: response(cash, 'payments'),
        tooMuch: response(tooMuch),
        voidPayment: response(voidPayment),
        state: await folioState(folioId),
      }));
      expect(snapshot).toMatchSnapshot();
    });
  });

  // ==================================================================
  // 2. POS Register
  // ==================================================================

  describe('2. POS Register', () => {
    it('cash with tip and service charge; settlement preview; a manager voids the cash settlement', async () => {
      const { orderId, opened, last } = await openTab('Golden Cash', [[register.beerId, 2]]);
      const previewRes = await preview(orderId);
      const settled = await settle(orderId, [{ method: 'cash', service_charge: '3.00', tip_amount: '2.00' }]);
      const settlementId = settled.body.data?.settlements?.[0]?.id;
      const voidApproval = await approval('pos.void_settlement', settlementId);
      const voided = await post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', voidApproval).send({ reason: 'Golden keyed in error' });

      const snapshot = await golden(async () => ({
        opened: response(opened, 'pos_orders'),
        afterItems: response(last, 'pos_orders'),
        preview: response(previewRes),
        settled: response(settled),
        voided: response(voided, 'pos_order_settlements'),
        state: await posState(orderId),
        audit: await auditTrail({ pos_orders: [orderId], pos_order_settlements: [settlementId] }),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('external terminal: provider + reference, a recorded terminal account, and a cash/terminal split bill', async () => {
      const plain = await openTab('Golden Terminal 1', [[register.beerId, 1]]);
      const plainSettled = await settle(plain.orderId, [{ method: 'terminal', terminal_provider: 'Moniepoint', terminal_reference: 'MP-GOLDEN-0001', service_charge: '1.50' }]);

      const withAccount = await openTab('Golden Terminal 2', [[register.wineId, 1]]);
      const accountSettled = await settle(withAccount.orderId, [{ method: 'terminal', terminal_account_id: register.terminalAccountId, terminal_reference: 'GTB-GOLDEN-77', service_charge: '2.63' }]);

      const split = await openTab('Golden Split', [[register.beerId, 1], [register.wineId, 1]]);
      const items = split.last.body.data?.items ?? [];
      const group1 = await post(`/api/v1/pos/orders/${split.orderId}/items/${items[0].id}/split-group`, { idempotent: false }).send({ split_group: 1 });
      const group2 = await post(`/api/v1/pos/orders/${split.orderId}/items/${items[1].id}/split-group`, { idempotent: false }).send({ split_group: 2 });
      const splitSettled = await settle(split.orderId, [
        { split_group: 1, method: 'cash', service_charge: '1.50' },
        { split_group: 2, method: 'terminal', terminal_provider: 'opay', service_charge: '2.63' },
      ]);

      const badProvider = await openTab('Golden Bad Provider', [[register.beerId, 1]]);
      const refused = await settle(badProvider.orderId, [{ method: 'terminal', terminal_provider: 'paypal', service_charge: '1.50' }]);
      await post(`/api/v1/pos/orders/${badProvider.orderId}/void`, { idempotent: false }).send({ reason: 'Golden cleanup' });

      const snapshot = await golden(async () => ({
        plain: response(plainSettled),
        withAccount: response(accountSettled),
        splitGroups: [response(group1, 'pos_order_items'), response(group2, 'pos_order_items')],
        split: response(splitSettled),
        refusedProvider: response(refused),
        state: {
          plain: await posState(plain.orderId),
          withAccount: await posState(withAccount.orderId),
          split: await posState(split.orderId),
          refused: await posState(badProvider.orderId),
        },
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('Paystack card: checkout priced server-side with the 7.5% service charge, verify, settle; void refused; gateway refund voids the settlement', async () => {
      const { orderId } = await openTab('Golden Card', [[register.beerId, 2]]);
      const previewRes = await preview(orderId);
      initMock('golden-reg-card');
      const checkout = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card', amount: '1.00' });
      const retry = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      const paymentId = checkout.body.data.id;
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_golden_reg_card', channel: 'card' }));
      const verify = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${paymentId}/verify`, { idempotent: false });
      const orderRead = await get(`/api/v1/pos/orders/${orderId}`);
      const settled = await settle(orderId, [{ method: 'card', service_charge: '3.00', payment_id: paymentId }]);
      const settlementId = settled.body.data?.settlements?.[0]?.id;
      const voidRefusedApproval = await approval('pos.void_settlement', settlementId);
      const voidRefused = await post(`/api/v1/pos/orders/${orderId}/settlements/${settlementId}/void`).set('X-Manager-Approval', voidRefusedApproval).send({ reason: 'Golden wrong tab' });
      const afterSettle = await posState(orderId);

      paystack.refundTransaction.mockImplementation(async ({ reference }) => ({ status: 'processed', reference }));
      const refundApproval = await approval('pos.refund_payment', paymentId);
      const refund = await post(`/api/v1/cashiering/payments/${paymentId}/refund`).set('X-Manager-Approval', refundApproval).send({ reason: 'Golden Register refund' });

      const snapshot = await golden(async () => ({
        preview: response(previewRes),
        checkout: response(checkout, 'payments'),
        retry: response(retry, 'payments'),
        verify: response(verify, 'payments'),
        orderRead: response(orderRead, 'pos_orders'),
        settled: response(settled),
        voidRefused: response(voidRefused),
        afterSettle,
        refund: response(refund, 'payments'),
        final: await posState(orderId),
        refundRows: await dbRows('payments', { parent_payment_id: paymentId }),
        audit: await auditTrail({ payments: [paymentId, refund.body.data?.id], pos_orders: [orderId], pos_order_settlements: [settlementId] }),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('NQR: QR-only checkout with the customer email, verify (channel qr), settle as tender nqr', async () => {
      const { orderId } = await openTab('Golden NQR', [[register.wineId, 1]]);
      initMock('golden-reg-nqr');
      const checkout = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'nqr', customer_email: 'walkin.golden@example.com' });
      const paymentId = checkout.body.data.id;
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_golden_reg_nqr', channel: 'qr' }));
      const verify = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout/${paymentId}/verify`, { idempotent: false });
      const settled = await settle(orderId, [{ method: 'card', service_charge: '2.63', payment_id: paymentId }]);

      const snapshot = await golden(async () => ({
        checkout: response(checkout, 'payments'),
        verify: response(verify, 'payments'),
        settled: response(settled),
        state: await posState(orderId),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('card settle refusals (missing / not captured), tender switch cancels, and a late capture of the cancelled checkout via webhook', async () => {
      const { orderId } = await openTab('Golden Late', [[register.beerId, 1]]);
      const missing = await settle(orderId, [{ method: 'card', service_charge: '1.50' }]);
      initMock('golden-reg-late');
      const card = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'card' });
      const notCaptured = await settle(orderId, [{ method: 'card', service_charge: '1.50', payment_id: card.body.data.id }]);
      const nqr = await post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({ tender: 'nqr' });

      const cancelled = await t.trx('payments').where({ id: card.body.data.id }).first();
      paystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(cancelled, { providerPaymentId: '91003', channel: 'card' }));
      const late = await postWebhook(cancelled, 91003);
      // A capture with no settlement is reported on its captured_at date; pin it to the business date (as the reconciliation suite does).
      await t.trx('payments').where({ id: card.body.data.id }).update({ captured_at: new Date(`${BUSINESS_DATE}T12:00:00Z`) });
      const orderRead = await get(`/api/v1/pos/orders/${orderId}`);

      const snapshot = await golden(async () => ({
        missing: response(missing),
        card: response(card, 'payments'),
        notCaptured: response(notCaptured),
        nqr: response(nqr, 'payments'),
        lateWebhook: { status: late.status, body: norm(late.body) },
        events: await dbRows('payment_webhook_events', { provider_event_id: '91003' }),
        orderRead: response(orderRead, 'pos_orders'),
        state: await posState(orderId),
        audit: await auditTrail({ payments: [card.body.data.id, nqr.body.data.id] }),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });
  });

  // ==================================================================
  // 3. QR guest order paid by card
  // ==================================================================

  describe('3. QR guest order paid by card', () => {
    let qr;

    beforeAll(async () => {
      const redis = rateLimitRedisConnection();
      for (const prefix of ['qr-order-ip-rl:', 'qr-retry-checkout-ip-rl:', 'qr-confirm-payment-ip-rl:', 'qr-otp-request-ip-rl:', 'qr-otp-verify-ip-rl:']) {
        const keys = await redis.keys(`${prefix}*`);
        if (keys.length) await redis.del(...keys);
      }
      const [outletId] = await t.trx('pos_outlets').insert({
        tenant_id: ctx.a.id,
        property_id: propertyId,
        code: 'GOLDEN-QR',
        name: 'Golden QR Cafe',
        type: 'restaurant',
        guest_ordering_enabled: true,
        guest_order_accept_timeout_minutes: 10,
        guest_order_rate_limit_max: 100,
      });
      const [juiceId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Golden Juice', category: 'Juices', price: '20.00' });
      const token = await post('/api/v1/pos/qr-tokens', { idempotent: false }).send({ outlet_id: outletId, type: 'table', table_label: 'GOLDEN-T1' });
      expect(token.status).toBe(201);
      qr = { outletId, juiceId, raw: token.body.meta.rawToken };
    });

    const guestPost = (path) => t.request.post(`/api/v1/qr-order/${qr.raw}${path}`).set('X-Tenant-Slug', ctx.a.slug);
    const guestGet = (path) => t.request.get(`/api/v1/qr-order/${qr.raw}${path}`).set('X-Tenant-Slug', ctx.a.slug);

    it('creates the order with a Paystack checkout, confirm-payment captures and settles it', async () => {
      initMock('golden-qr-1');
      const created = await guestPost('/orders').set('Idempotency-Key', idemKey()).send({ payment_method: 'card', guest_contact: 'qr.golden@example.com', guest_name: 'QR Golden', items: [{ menu_item_id: qr.juiceId, quantity: 2 }] });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_golden_qr_1', channel: 'card' }));
      const confirmed = await guestPost(`/orders/${created.body.data.id}/confirm-payment`).send({});
      const status = await guestGet(`/orders/${created.body.data.id}`);
      const posOrderId = created.body.data.pos_order_id;

      const snapshot = await golden(async () => ({
        created: response(created, 'pos_guest_orders'),
        confirmed: response(confirmed),
        status: response(status, 'pos_guest_orders'),
        guestOrder: await dbRows('pos_guest_orders', { id: created.body.data.id }),
        state: await posState(posOrderId),
        alerts: (await t.trx('in_app_notifications').where({ type: 'qr_ordering.guest_order_placed' }).orderBy('id')).map(({ payload, type, popup }) => ({ type, popup, payload: typeof payload === 'string' ? JSON.parse(payload) : payload })),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });

    it('a paid order rejected by staff is refunded in full and its settlement voided', async () => {
      initMock('golden-qr-2');
      const created = await guestPost('/orders').set('Idempotency-Key', idemKey()).send({ payment_method: 'card', guest_contact: 'qr.reject@example.com', items: [{ menu_item_id: qr.juiceId, quantity: 1 }] });
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_golden_qr_2', channel: 'card' }));
      await guestPost(`/orders/${created.body.data.id}/confirm-payment`).send({});
      paystack.refundTransaction.mockImplementation(async ({ reference }) => ({ status: 'processed', reference }));
      const rejected = await post(`/api/v1/pos/guest-orders/${created.body.data.id}/reject`, { idempotent: false }).send({ reason: 'Golden kitchen closed' });

      const snapshot = await golden(async () => ({
        rejected: response(rejected, 'pos_guest_orders'),
        guestOrder: await dbRows('pos_guest_orders', { id: created.body.data.id }),
        state: await posState(created.body.data.pos_order_id),
        paystack: paystackCalls(),
      }));
      expect(snapshot).toMatchSnapshot();
    });
  });

  // ==================================================================
  // 4. Front desk: charge-to-room from the Register, payment, checkout
  // ==================================================================

  describe('4. front desk checkout against the folio', () => {
    it('room charge + Register charge-to-room → checkout refused while owing → cash payment → checkout succeeds at zero', async () => {
      const [roomTypeId] = await t.trx('room_types').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'GOLD-RT', name: 'Golden Room', default_occupancy: 2, base_rate: '150.00' });
      const [roomId] = await t.trx('rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, room_type_id: roomTypeId, room_number: 'G-101', status: 'active', front_desk_status: 'occupied' });
      const [rateCodeId] = await t.trx('rate_codes').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: 'GOLD-RATE', base_rate: '150.00', currency: 'NGN', valid_from: '2026-01-01' });
      const [reservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: propertyId,
        guest_id: ctx.a.guests[0].id,
        room_type_id: roomTypeId,
        rate_code_id: rateCodeId,
        arrival_date: BUSINESS_DATE,
        departure_date: '2027-08-11',
        adults: 1,
        children: 0,
        status: 'checked_in',
        confirmation_number: 'GOLDENCONF0001',
        checked_in_at: new Date(`${BUSINESS_DATE}T14:00:00Z`),
      });
      await t.trx('reservation_rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(`${BUSINESS_DATE}T14:00:00Z`), effective_to: null });
      const folioId = await openFolio(reservationId);

      const roomCharge = await post(`/api/v1/cashiering/folios/${folioId}/charges`).send({ type: 'room_charge', description: 'Room G-101', amount: '150.00' });
      const tab = await openTab('Golden Room Service', [[register.wineId, 1]]);
      const roomSettle = await settle(tab.orderId, [{ method: 'room_charge', service_charge: '2.63', room_charge: { reservation_id: reservationId, auth_method: 'pin', auth_reference: 'PIN entered' } }]);
      const owing = await post(`/api/v1/reservations/${reservationId}/check-out`).send({});
      const balance = (await t.trx('folios').where({ id: folioId }).first()).balance;
      const cash = await post(`/api/v1/cashiering/folios/${folioId}/payments/cash`).send({ amount: balance, currency: 'NGN' });
      const checkout = await post(`/api/v1/reservations/${reservationId}/check-out`).send({});

      const snapshot = await golden(async () => ({
        roomCharge: response(roomCharge, 'folio_line_items'),
        roomSettle: response(roomSettle),
        posState: await posState(tab.orderId),
        checkoutWhileOwing: response(owing),
        balanceBeforePayment: balance,
        cash: response(cash, 'payments'),
        checkout: response(checkout, 'reservations'),
        reservation: await dbRows('reservations', { id: reservationId }),
        folio: await folioState(folioId),
        audit: await auditTrail({ reservations: [reservationId] }),
      }));
      expect(snapshot).toMatchSnapshot();
    });
  });

  // ==================================================================
  // 5. Reports over everything above
  // ==================================================================

  describe('5. reconciliation and POS Sales reports', () => {
    it('GET /reconciliation/payments (JSON + CSV)', async () => {
      const json = await get(`/api/v1/reconciliation/payments?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      const csvRes = await get(`/api/v1/reconciliation/payments?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv`);
      const snapshot = await golden(async () => {
        const body = norm(json.body);
        const data = body.data ?? {};
        // Server order: lines by business date then captured_at (ties within a second are arbitrary);
        // bySource / byMethod / bySettlementAccount by gross (ties by insertion order, i.e. by time).
        // byCurrency and byTerminalProvider are fully ordered by the server and kept as returned.
        if (data.lines) data.lines = tieSorted(json.body.data.lines, null, businessDateDesc);
        for (const key of ['bySource', 'byMethod', 'bySettlementAccount']) {
          if (data[key]) data[key] = tieSorted(json.body.data[key], null, grossDesc);
        }
        return { status: json.status, body, csv: csv(csvRes) };
      });
      expect(snapshot).toMatchSnapshot();
    });

    it('GET /pos/reports/sales (JSON + every CSV section)', async () => {
      const json = await get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}`);
      const sections = {};
      for (const section of ['tabs', 'items', 'tenders', 'outlets']) {
        sections[section] = await get(`/api/v1/pos/reports/sales?date_from=${BUSINESS_DATE}&date_to=${BUSINESS_DATE}&format=csv&section=${section}`);
      }
      const snapshot = await golden(async () => {
        const body = norm(json.body);
        const data = body.data ?? {};
        // Tabs come by settled_at (whole seconds — ties are arbitrary), and a tab's payments/tenders
        // in settlement order (a split bill settles both in the same second). byTender, byOutlet and
        // topItems are fully ordered by the server and kept as returned.
        if (data.tabs) {
          data.tabs = tieSorted(
            json.body.data.tabs.map((tab) => ({
              ...tab,
              ...(Array.isArray(tab.payments) ? { payments: tieSorted(tab.payments, 'payments') } : {}),
              ...(Array.isArray(tab.tenders) ? { tenders: [...tab.tenders].sort() } : {}),
            })),
            'pos_orders'
          );
        }
        const csvs = {};
        for (const [name, res] of Object.entries(sections)) csvs[name] = csv(res);
        return { status: json.status, body, csv: csvs };
      });
      expect(snapshot).toMatchSnapshot();
    });
  });
});
