'use strict';

/**
 * HTTP-level tests for the POS module — PLAN.md Phase 4's POS core
 * (PRODUCT_REQUIREMENTS.md §3.4). Covers outlet/terminal/menu CRUD and
 * RBAC (the `pos.operate`/`pos.manage` split — this session's confirmed
 * decision), the order flow (open a tab, add/void items pre-settlement,
 * item-group splitting), settlement (cash, card, and charge-to-room —
 * including every rejection path PRODUCT_REQUIREMENTS.md §3.4 names:
 * no in-house reservation, closed folio, missing authorization), the
 * post-settlement "manager override" void, and blind cash-up shifts.
 *
 * ── AMBIENT TAX ──────────────────────────────────────────────────────────
 *
 * `tests/helpers/fixtures.js` seeds a real 7.5% `VAT` tax
 * (`applies_to: 'all'`) on BOTH tenants' first property (`ctx.a` and
 * `ctx.b` alike — confirmed by reading `seedTwoTenants` directly, not
 * assumed) — it applies to `pos_charge` exactly as it does to
 * `room_charge` (`applies_to: 'all'` matches any charge type), so every
 * settlement in this file expects it: a $20.00 item's tax_amount is
 * always $1.50 (`cashiering.test.js`'s own header establishes this same
 * convention for room charges). This file's own settlement-preview tests
 * mostly use `ctx.a` for this reason; the one exception (a genuinely
 * isolated inclusive-tax scenario) deliberately targets `ctx.b` instead,
 * removing its ambient VAT row first — see that test's own comment.
 *
 * Cross-tenant isolation for every POS table already comes free from
 * tests/isolation's ISO-* suite via tests/helpers/entities.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { sumMoney } = require('../../src/shared/money');

describe('POS (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex = 0, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `pos-test-key-${idemCounter}`;
  }

  let outletCounter = 0;

  /** A fresh, isolated outlet/terminal/menu item — most tests don't need to share the shared fixture's own BAR outlet. */
  async function freshOutletSetup(tenant = ctx.a, { price = '20.00' } = {}) {
    outletCounter += 1;
    const suffix = `${Date.now()}-${outletCounter}`;
    const propertyId = tenant.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      code: `POS-${suffix}`,
      name: 'Test Outlet',
      type: 'bar',
    });
    const [terminalId] = await t.trx('pos_terminals').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      outlet_id: outletId,
      device_ref: `TERM-${suffix}`,
    });
    const [menuItemId] = await t.trx('pos_menu_items').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Test Item',
      category: 'Drinks',
      price,
    });
    return { propertyId, outletId, terminalId, menuItemId };
  }

  async function openOrder(token, { outletId, terminalId, tableLabel = 'T1' }) {
    const res = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet_id: outletId, terminal_id: terminalId, table_label: tableLabel });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function addItem(token, orderId, { menuItemId, quantity = 1 }) {
    const res = await t.request
      .post(`/api/v1/pos/orders/${orderId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ menu_item_id: menuItemId, quantity });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  let inHouseCounter = 0;

  /** A fresh in-house reservation + open folio, for charge-to-room tests. Same recipe `night-audit.test.js`'s own `freshInHouseSetup` uses. */
  async function freshInHouseGuest(tenant = ctx.a, { propertyId }) {
    inHouseCounter += 1;
    const suffix = `${Date.now()}-${inHouseCounter}`;
    const [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      code: `PRT-${suffix}`,
      name: 'POS Room Type',
      default_occupancy: 2,
      base_rate: '150.00',
    });
    const [roomId] = await t.trx('rooms').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      room_type_id: roomTypeId,
      room_number: `9${inHouseCounter}`,
      status: 'active',
      front_desk_status: 'occupied',
    });
    const [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      code: `PRATE-${suffix}`,
      base_rate: '150.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      guest_id: tenant.guests[0].id,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2027-03-01',
      departure_date: '2029-12-31',
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `PR${suffix}`.toUpperCase().slice(0, 26),
      checked_in_at: new Date(),
    });
    await t.trx('reservation_rooms').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      reservation_id: reservationId,
      room_id: roomId,
      effective_from: new Date(),
      effective_to: null,
    });
    const [folioId] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `PRFOLIO${suffix}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    });
    return { reservationId, folioId, roomId };
  }

  // -----------------------------------------------------------------------
  // Outlets / terminals / menu items — CRUD + RBAC
  // -----------------------------------------------------------------------

  describe('outlets/terminals/menu items', () => {
    it('pos.manage can create an outlet, terminal, and menu item; pos.operate can read but not write', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const managerToken = tokenFor({ userId: ctx.a.users[0].id });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });

      const create = await t.request
        .post('/api/v1/pos/outlets')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ code: `RESTAURANT-${Date.now()}`, name: 'Test Restaurant', type: 'restaurant' });
      expect(create.status).toBe(201);
      const outletId = create.body.data.id;

      const forbidden = await t.request
        .post('/api/v1/pos/outlets')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ code: `NOPE-${Date.now()}`, name: 'Nope', type: 'bar' });
      expect(forbidden.status).toBe(403);

      const list = await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${operatorToken}`);
      expect(list.status).toBe(200);
      expect(list.body.data.some((o) => o.id === outletId)).toBe(true);

      const terminal = await t.request
        .post('/api/v1/pos/terminals')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ outlet_id: outletId, device_ref: `DEV-${Date.now()}`, supports_contactless: true });
      expect(terminal.status).toBe(201);

      const menuItem = await t.request
        .post('/api/v1/pos/menu-items')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ outlet_id: outletId, name: 'Grilled Fish', category: 'Mains', price: '35.00' });
      expect(menuItem.status).toBe(201);
    });

    it('rejects a duplicate outlet code at the same property with a real conflict, not a raw 500', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'admin' });
      const token = tokenFor({ userId: ctx.a.users[0].id });
      const code = `DUPOUTLET-${Date.now()}`;
      const first = await t.request.post('/api/v1/pos/outlets').set('Authorization', `Bearer ${token}`).send({ code, name: 'First', type: 'bar' });
      expect(first.status).toBe(201);
      const second = await t.request.post('/api/v1/pos/outlets').set('Authorization', `Bearer ${token}`).send({ code, name: 'Second', type: 'bar' });
      expect(second.status).toBe(409);
    });

    it('front_desk/cashier/housekeeping get 403 on both pos.operate and pos.manage endpoints', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'cashier' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const read = await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${token}`);
      expect(read.status).toBe(403);
    });

    it('the stock-out toggle is reachable by pos.operate, not just pos.manage', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();

      const res = await t.request
        .post(`/api/v1/pos/menu-items/${setup.menuItemId}/set-availability`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ is_available: false });
      expect(res.status).toBe(200);
      expect(res.body.data.is_available).toBe(0);
    });

    // Editing an outlet/terminal/menu item — this session's own broader POS
    // review found the SetupTab UI never called any of these, and building
    // its first real edit forms surfaced a real, previously-uncalled bug:
    // `updateOutlet`/`updateTerminal`/`updateMenuItem` took `req.body ?? {}`
    // straight through with no field allowlist. Fixed alongside building
    // the first live caller — these tests are this fix's own proof.
    it('pos.manage can edit an outlet, terminal, and menu item; pos.operate cannot', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const managerToken = tokenFor({ userId: ctx.a.users[0].id });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();

      const outletEdit = await t.request
        .patch(`/api/v1/pos/outlets/${setup.outletId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Renamed Outlet', type: 'restaurant' });
      expect(outletEdit.status).toBe(200);
      expect(outletEdit.body.data.name).toBe('Renamed Outlet');
      expect(outletEdit.body.data.type).toBe('restaurant');

      const terminalEdit = await t.request
        .patch(`/api/v1/pos/terminals/${setup.terminalId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ device_ref: 'RENAMED-DEV', supports_contactless: true });
      expect(terminalEdit.status).toBe(200);
      expect(terminalEdit.body.data.device_ref).toBe('RENAMED-DEV');
      expect(terminalEdit.body.data.supports_contactless).toBe(1);

      const menuItemEdit = await t.request
        .patch(`/api/v1/pos/menu-items/${setup.menuItemId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Renamed Item', category: 'Snacks', price: '25.00' });
      expect(menuItemEdit.status).toBe(200);
      expect(menuItemEdit.body.data.name).toBe('Renamed Item');
      expect(menuItemEdit.body.data.category).toBe('Snacks');
      expect(menuItemEdit.body.data.price).toBe('25.00');

      const forbidden = await t.request
        .patch(`/api/v1/pos/outlets/${setup.outletId}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ name: 'Nope' });
      expect(forbidden.status).toBe(403);
    });

    it('bug fix: editing an outlet/terminal/menu item ignores tenant_id/property_id/id/status in the request body', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      const token = tokenFor({ userId: ctx.a.users[0].id });
      const setup = await freshOutletSetup();

      const outletEdit = await t.request
        .patch(`/api/v1/pos/outlets/${setup.outletId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Real Name', tenant_id: '999999', property_id: '999999', id: '999999', status: 'archived' });
      expect(outletEdit.status).toBe(200);
      expect(outletEdit.body.data.id).toBe(String(setup.outletId));
      expect(outletEdit.body.data.status).toBe('active');
      // Re-fetch through the ordinary list to confirm the row itself, not
      // just the response, was never actually archived.
      const list = await t.request.get('/api/v1/pos/outlets').set('Authorization', `Bearer ${token}`);
      expect(list.body.data.some((o) => o.id === String(setup.outletId))).toBe(true);

      const menuItemEdit = await t.request
        .patch(`/api/v1/pos/menu-items/${setup.menuItemId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Real Item', status: 'archived', is_available: false });
      expect(menuItemEdit.status).toBe(200);
      expect(menuItemEdit.body.data.status).toBe('active');
      expect(menuItemEdit.body.data.is_available).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Order flow
  // -----------------------------------------------------------------------

  describe('order flow', () => {
    it('opens a tab, adds items, and voids one with a reason before settlement', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();

      const order = await openOrder(token, setup);
      expect(order.status).toBe('open');

      const afterAdd = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 2 });
      expect(afterAdd.items).toHaveLength(1);
      expect(afterAdd.items[0].unit_price).toBe('20.00');

      const voidRes = await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${afterAdd.items[0].id}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Wrong item entered' });
      expect(voidRes.status).toBe(200);
      expect(voidRes.body.data.voided_at).not.toBeNull();

      // Voiding the same item again is a conflict, not a silent no-op.
      const again = await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${afterAdd.items[0].id}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Again' });
      expect(again.status).toBe(409);
    });

    it('rejects adding an item to a voided order', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);

      const voided = await t.request.post(`/api/v1/pos/orders/${order.id}/void`).set('Authorization', `Bearer ${token}`).send({ reason: 'Guest left' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.status).toBe('void');

      const addAfterVoid = await t.request
        .post(`/api/v1/pos/orders/${order.id}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ menu_item_id: setup.menuItemId, quantity: 1 });
      expect(addAfterVoid.status).toBe(409);
    });

    it('rejects an unavailable (stocked-out) item', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      await t.trx('pos_menu_items').where({ id: setup.menuItemId }).update({ is_available: false });
      const order = await openOrder(token, setup);

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/items`)
        .set('Authorization', `Bearer ${token}`)
        .send({ menu_item_id: setup.menuItemId, quantity: 1 });
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Settlement preview — read-only, never commits anything
  // -----------------------------------------------------------------------

  // Gap closure (this session's own "test and review Register" pass): the
  // Register screen's settlement panel used to omit tax entirely from its
  // "Amount to charge" preview — a real, live-confirmed discrepancy (see
  // `RegisterTab.jsx`'s own header). This is the endpoint that closes it,
  // reusing the exact same tax computation `settleOrder` itself uses.
  describe('GET /pos/orders/:id/settlement-preview', () => {
    it('previews the real subtotal and tax for an ungrouped tab, computed against the ambient 7.5% VAT', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.groups).toEqual([{ splitGroup: null, subtotal: '20.00', taxAmount: '1.50' }]);
    });

    it('previews each split group independently — a tab split into two groups', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      const added1 = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      const item1 = added1.items[0];
      const added2 = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 2 });
      const item2 = added2.items[1];

      await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${item1.id}/split-group`)
        .set('Authorization', `Bearer ${token}`)
        .send({ split_group: 1 })
        .expect(200);
      await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${item2.id}/split-group`)
        .set('Authorization', `Bearer ${token}`)
        .send({ split_group: 2 })
        .expect(200);

      const res = await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const byGroup = Object.fromEntries(res.body.data.groups.map((g) => [g.splitGroup, g]));
      expect(byGroup[1]).toEqual({ splitGroup: 1, subtotal: '20.00', taxAmount: '1.50' });
      expect(byGroup[2]).toEqual({ splitGroup: 2, subtotal: '40.00', taxAmount: '3.00' });
    });

    // Correctness nuance a naive "always add tax on top of the raw item
    // total" client-side implementation would get wrong: for an INCLUSIVE
    // tax, `subtotal` (the tax engine's own `netAmount`) is already the
    // item total minus the tax baked into it — `subtotal + taxAmount` must
    // equal the raw item total exactly, proving the frontend's grand-total
    // formula (`sumMoney([subtotal, taxAmount, tip, service])`) can never
    // double-count tax regardless of which tax mode a property configures.
    it('an inclusive tax: subtotal is the net amount, and subtotal + tax equals the true item total exactly', async () => {
      // Uses ctx.b, not ctx.a — ctx.a's property already carries the file's
      // own ambient 7.5% EXCLUSIVE VAT fixture (this file's own header),
      // and a real tax row inserted directly here lives for the rest of
      // this file's shared transaction, not just this one test. Inserting
      // an inclusive tax onto ctx.a's property would stack with that
      // ambient one and leak into every later test in this file that
      // shares it — confirmed the hard way, not guessed: an earlier draft
      // of this test did exactly that and broke a later, unrelated
      // settlement test's own expected tax amount.
      await grantRoleToUser({ tenant: ctx.b, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ tenant: ctx.b, userId: ctx.b.users[1].id });
      // ctx.b's property carries no current_business_date by default
      // (only ctx.a's is set, in this file's own top-level beforeAll) —
      // without one, resolveApplicableTaxVersions has no date to resolve
      // an effective-dated tax version against, and this test's own tax
      // row would silently never apply.
      await t.trx('properties').where({ id: ctx.b.properties[0].id }).update({ current_business_date: '2027-03-01' });
      // `tests/helpers/fixtures.js`'s own `seedTwoTenants` seeds the
      // identical ambient 7.5% EXCLUSIVE VAT onto BOTH tenants' first
      // property, not just ctx.a's (confirmed by reading it directly —
      // this file's own header comment undersells it as ctx.a-only).
      // Removed here so this test measures exactly one, cleanly inclusive
      // tax — nothing else in this file uses ctx.b, so this can't affect
      // any other test.
      await t.trx('taxes').where({ property_id: ctx.b.properties[0].id, tax_code: 'VAT' }).del();
      const setup = await freshOutletSetup(ctx.b, { price: '107.50' });
      await t.trx('taxes').insert({
        tenant_id: ctx.b.id,
        property_id: setup.propertyId,
        tax_code: `INCL-${Date.now()}`,
        name: 'Inclusive test tax',
        rate: '7.50',
        applies_to: 'all',
        effective_from: '2020-01-01',
        is_inclusive: true,
        calculation_method: 'percentage',
        priority: 1,
        is_compound: false,
        rounding_method: 'half_up',
      });
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const group = res.body.data.groups[0];
      expect(sumMoney([group.subtotal, group.taxAmount])).toBe('107.50');
      expect(group.subtotal).not.toBe('107.50'); // genuinely net of the inclusive tax, not just echoing the raw price
    });

    it('is genuinely read-only — no settlement row is created and the order stays open', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`).expect(200);

      const orderRow = await t.trx('pos_orders').where({ id: order.id }).first();
      expect(orderRow.status).toBe('open');
      const settlementRows = await t.trx('pos_order_settlements').where({ pos_order_id: order.id });
      expect(settlementRows).toHaveLength(0);
    });

    it('front_desk/cashier/housekeeping get 403 — same pos.operate gate as the rest of the register flow', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'cashier' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      const managerToken = tokenFor({ userId: ctx.a.users[0].id });
      const order = await openOrder(managerToken, setup);

      const res = await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('a friendly VALIDATION_ORDER_NOT_FOUND for a nonexistent order (matching settleOrder\'s own convention), 409 for an already-settled one', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });

      const missing = await t.request.get('/api/v1/pos/orders/999999999/settlement-preview').set('Authorization', `Bearer ${token}`);
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('VALIDATION_ORDER_NOT_FOUND');

      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'cash' }] })
        .expect(200);

      const afterSettle = await t.request.get(`/api/v1/pos/orders/${order.id}/settlement-preview`).set('Authorization', `Bearer ${token}`);
      expect(afterSettle.status).toBe(409);
    });
  });

  // -----------------------------------------------------------------------
  // Settlement
  // -----------------------------------------------------------------------

  describe('settlement', () => {
    it('settles a single-group tab by cash, computing tax against the ambient 7.5% VAT', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'cash' }] });

      expect(res.status).toBe(200);
      expect(res.body.data.order.status).toBe('settled');
      expect(res.body.data.settlements).toHaveLength(1);
      expect(res.body.data.settlements[0].subtotal).toBe('20.00');
      expect(res.body.data.settlements[0].tax_amount).toBe('1.50');
    });

    it('replays the exact same response on a retried Idempotency-Key, never double-settling', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      const key = idemKey();

      const first = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ settlements: [{ method: 'cash' }] });
      expect(first.status).toBe(200);

      const replay = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ settlements: [{ method: 'cash' }] });
      expect(replay.status).toBe(200);
      expect(replay.body.data.settlements[0].id).toBe(first.body.data.settlements[0].id);

      const settlementRows = await t.trx('pos_order_settlements').where({ pos_order_id: order.id });
      expect(settlementRows).toHaveLength(1);
    });

    it('rejects settling an order twice under different keys — already settled', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const first = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'cash' }] });
      expect(first.status).toBe(200);

      const second = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'cash' }] });
      expect(second.status).toBe(409);
    });

    it('splits a tab into two item groups, settling each independently — a room charge plus a cash tip', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const guest = await freshInHouseGuest(ctx.a, { propertyId: setup.propertyId });
      const order = await openOrder(token, setup);
      const added1 = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      const item1 = added1.items[0];
      const added2 = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      const item2 = added2.items[1];

      await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${item1.id}/split-group`)
        .set('Authorization', `Bearer ${token}`)
        .send({ split_group: 1 })
        .expect(200);
      await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${item2.id}/split-group`)
        .set('Authorization', `Bearer ${token}`)
        .send({ split_group: 2 })
        .expect(200);

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          settlements: [
            {
              split_group: 1,
              method: 'room_charge',
              room_charge: { reservation_id: guest.reservationId, auth_method: 'pin', auth_reference: 'PIN entered' },
            },
            { split_group: 2, method: 'cash', tip_amount: '5.00' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.settlements).toHaveLength(2);
      const roomSettlement = res.body.data.settlements.find((s) => s.method === 'room_charge');
      // BIGINT ids come back from MySQL as strings (ARCHITECTURE.md §10) — guest.folioId is a plain JS number from the insert call.
      expect(String(roomSettlement.folio_id)).toBe(String(guest.folioId));

      const folio = await t.trx('folios').where({ id: guest.folioId }).first();
      // 20.00 charge + 1.50 tax = 21.50 posted to the folio.
      expect(folio.balance).toBe('21.50');
    });

    it('rejects a settlement request that leaves a split group uncovered', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      const added1 = await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      await t.request
        .post(`/api/v1/pos/orders/${order.id}/items/${added1.items[0].id}/split-group`)
        .set('Authorization', `Bearer ${token}`)
        .send({ split_group: 1 });
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 }); // stays ungrouped (null)

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ split_group: 1, method: 'cash' }] }); // group `null` never covered
      expect(res.status).toBe(422);
    });

    it('rejects a settlement request that targets the same group twice, rather than charging it twice', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        // Two settlement entries, both targeting the single (null) group —
        // a naive set-based coverage check would accept this (both dedupe
        // to the same key) and the processing loop would then charge the
        // same items twice.
        .send({ settlements: [{ method: 'cash' }, { method: 'cash' }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_POS_SETTLEMENT_GROUPS_MISMATCH');

      // No partial write: the order is still open, and nothing was settled.
      const orderRow = await t.trx('pos_orders').where({ id: order.id }).first();
      expect(orderRow.status).toBe('open');
      const settlementCount = await t.trx('pos_order_settlements').where({ pos_order_id: order.id }).count({ n: '*' }).first();
      expect(Number(settlementCount.n)).toBe(0);
    });

    it('posts a room-charge settlement\'s tip/service charge to the folio as a separate, untaxed line — never silently dropped', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const guest = await freshInHouseGuest(ctx.a, { propertyId: setup.propertyId });
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          settlements: [
            {
              method: 'room_charge',
              tip_amount: '5.00',
              room_charge: { reservation_id: guest.reservationId, auth_method: 'pin', auth_reference: 'PIN entered' },
            },
          ],
        });
      expect(res.status).toBe(200);
      const settlement = res.body.data.settlements[0];
      expect(settlement.tip_service_charge_line_item_id).not.toBeNull();

      // 20.00 charge + 1.50 tax + 5.00 tip = 26.50 actually posted to the folio — the tip is not just recorded, it's billed.
      const folio = await t.trx('folios').where({ id: guest.folioId }).first();
      expect(folio.balance).toBe('26.50');

      const tipLine = await t.trx('folio_line_items').where({ id: settlement.tip_service_charge_line_item_id }).first();
      expect(tipLine.type).toBe('adjustment');
      expect(tipLine.amount).toBe('5.00');

      // Voiding the settlement voids the tip line too — no orphaned tip left on the folio.
      const voided = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settlements/${settlement.id}/void`)
        .set('Authorization', `Bearer ${tokenFor({ userId: ctx.a.users[0].id })}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'test cleanup' });
      expect(voided.status).toBe(200);
      const tipLineAfterVoid = await t.trx('folio_line_items').where({ id: settlement.tip_service_charge_line_item_id }).first();
      expect(tipLineAfterVoid.voided_at).not.toBeNull();
    });

    it('rejects charge-to-room when the room has no in-house reservation', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'room_charge', room_charge: { reservation_id: '999999999', auth_method: 'pin', auth_reference: 'x' } }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_POS_ROOM_CHARGE_REJECTED');
    });

    it('rejects charge-to-room when the folio is closed', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const guest = await freshInHouseGuest(ctx.a, { propertyId: setup.propertyId });
      await t.trx('folios').where({ id: guest.folioId }).update({ status: 'closed' });
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'room_charge', room_charge: { reservation_id: guest.reservationId, auth_method: 'pin', auth_reference: 'x' } }] });
      expect(res.status).toBe(422);
    });

    it('rejects charge-to-room with no authorization method/reference — a room number alone is not identification', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const guest = await freshInHouseGuest(ctx.a, { propertyId: setup.propertyId });
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'room_charge', room_charge: { reservation_id: guest.reservationId } }] });
      expect(res.status).toBe(400);
    });

    // Bug fix (this session's own "test and review Register" pass, live-
    // confirmed against the real dev database): `RegisterTab.jsx` could
    // submit a room_charge settlement with no guest ever selected — the
    // JSON body then carries `room_charge` with no `reservation_id` key at
    // all (JSON.stringify drops the `undefined` value). Before this fix,
    // `where({ id: undefined })` threw a raw, uncaught mysql2 exception —
    // a bare 500, not a validation error a person could act on.
    it('rejects charge-to-room with no guest/reservation selected — a friendly error, never a raw 500', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const res = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'room_charge', room_charge: { auth_method: 'pin', auth_reference: 'x' } }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');

      // The order was never partially processed — still open, no settlement row.
      const orderRow = await t.trx('pos_orders').where({ id: order.id }).first();
      expect(orderRow.status).toBe('open');
      const settlementRows = await t.trx('pos_order_settlements').where({ pos_order_id: order.id });
      expect(settlementRows).toHaveLength(0);
    });

    it('a post-settlement void requires pos.manage, not just pos.operate, and voids the underlying folio line for a room charge', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const managerToken = tokenFor({ userId: ctx.a.users[0].id });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();
      const guest = await freshInHouseGuest(ctx.a, { propertyId: setup.propertyId });
      const order = await openOrder(operatorToken, setup);
      await addItem(operatorToken, order.id, { menuItemId: setup.menuItemId, quantity: 1 });

      const settle = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'room_charge', room_charge: { reservation_id: guest.reservationId, auth_method: 'pin', auth_reference: 'x' } }] });
      const settlementId = settle.body.data.settlements[0].id;

      const forbidden = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settlements/${settlementId}/void`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Comp' });
      expect(forbidden.status).toBe(403);

      const voided = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settlements/${settlementId}/void`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Manager comp' });
      expect(voided.status).toBe(200);
      expect(voided.body.data.voided_at).not.toBeNull();

      const folioLine = await t.trx('folio_line_items').where({ id: voided.body.data.folio_line_item_id }).first();
      expect(folioLine.voided_at).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Shifts — blind cash-up
  // -----------------------------------------------------------------------

  describe('shifts', () => {
    it('opens a shift, rejects a second concurrent open on the same terminal, and blind-closes with a real variance', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const setup = await freshOutletSetup();

      const open = await t.request
        .post('/api/v1/pos/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ terminal_id: setup.terminalId, opening_float: '100.00' });
      expect(open.status).toBe(201);

      const secondOpen = await t.request
        .post('/api/v1/pos/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ terminal_id: setup.terminalId, opening_float: '100.00' });
      expect(secondOpen.status).toBe(409);

      // A real cash sale during the shift, on this same terminal.
      const order = await openOrder(token, setup);
      await addItem(token, order.id, { menuItemId: setup.menuItemId, quantity: 1 });
      await t.request
        .post(`/api/v1/pos/orders/${order.id}/settle`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ settlements: [{ method: 'cash' }] });

      // Blind close: the operator submits a count that is short by 2.00.
      const close = await t.request
        .post(`/api/v1/pos/shifts/${open.body.data.id}/close`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ counted_cash: '119.50' });
      expect(close.status).toBe(200);
      // opening 100.00 + (20.00 subtotal + 1.50 tax) cash taken = 121.50 expected.
      expect(close.body.data.expected_cash).toBe('121.50');
      expect(close.body.data.variance).toBe('-2.00');

      // Closing again is a real conflict, never a silent no-op.
      const closeAgain = await t.request
        .post(`/api/v1/pos/shifts/${open.body.data.id}/close`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ counted_cash: '119.50' });
      expect(closeAgain.status).toBe(409);
    });
  });
});
