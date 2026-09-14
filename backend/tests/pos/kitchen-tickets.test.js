'use strict';

/**
 * POS → Tickets: the kitchen/bar ticket queue. Tabs with something to make
 * that nobody has marked done — open or already paid — oldest first, with
 * unvoided items and their names; guest QR orders once paid; marking done;
 * a new item re-opening the ticket; an outlet filter; tenant isolation.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('GET /api/v1/pos/tickets', () => {
  const t = useTestApp();
  let ctx;
  let property;
  let outletId;
  let terminalId;
  let menuItemId;
  let secondOutletId;
  let secondMenuItemId;

  function tokenFor(tenant, userId) {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const operator = () => tokenFor(ctx.a, ctx.a.users[1].id);
  const manager = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const get = (query = '', token = operator()) => t.request.get(`/api/v1/pos/tickets${query}`).set('Authorization', `Bearer ${token}`);

  async function openTab({ label, openedAt, outlet = outletId, source = 'staff' }) {
    const [id] = await t.trx('pos_orders').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      outlet_id: outlet,
      terminal_id: source === 'staff' ? terminalId : null,
      opened_by_user_id: source === 'staff' ? ctx.a.users[0].id : null,
      table_label: label,
      source,
      opened_at: openedAt,
    });
    return id;
  }

  async function addItem(orderId, { quantity = 1, item = menuItemId, voided = false } = {}) {
    const [id] = await t.trx('pos_order_items').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      pos_order_id: orderId,
      menu_item_id: item,
      quantity,
      unit_price: '10.00',
      voided_at: voided ? new Date() : null,
      void_reason: voided ? 'test' : null,
    });
    return id;
  }

  async function guestOrder({ label, openedAt, status }) {
    const orderId = await openTab({ label, openedAt, source: 'guest' });
    await t.trx('pos_guest_orders').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      pos_order_id: orderId,
      token_id: ctx.a.posOrderTokens[0].id,
      payment_method: 'card',
      payment_status: status === 'awaiting_payment' ? 'unpaid' : 'paid',
      status,
      guest_name: 'Ada',
      accepted_at: ['preparing', 'on_the_way'].includes(status) ? new Date() : null,
    });
    await addItem(orderId, { quantity: 2 });
    return orderId;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.a, 1, 'pos_operator');
    property = ctx.a.properties[0];
    outletId = ctx.a.posOutlets[0].id;
    terminalId = ctx.a.posTerminals[0].id;
    menuItemId = ctx.a.posMenuItems[0].id;
    [secondOutletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: property.id, code: 'TK-KITCHEN', name: 'Kitchen', type: 'restaurant' });
    [secondMenuItemId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: property.id, outlet_id: secondOutletId, name: 'Jollof Rice', category: 'Mains', price: '30.00' });
  });

  // Tickets of the tabs this file created (fixtures seed a few of their own).
  const ours = (rows, ids) => rows.filter((row) => ids.map(String).includes(String(row.id)));

  it('lists undone tabs with items oldest first, open or already paid, leaving out voided items, empty, void and done tabs', async () => {
    const later = await openTab({ label: 'Window 2', openedAt: new Date('2026-09-13T10:05:00Z') });
    await addItem(later, { quantity: 3 });
    const earlier = await openTab({ label: 'Rooftop 4', openedAt: new Date('2026-09-13T10:00:00Z') });
    await addItem(earlier, { quantity: 2 });
    await addItem(earlier, { quantity: 1, voided: true });
    const empty = await openTab({ label: 'Nothing yet', openedAt: new Date('2026-09-13T09:00:00Z') });
    // Paid at the point of order (Send to Bar & Checkout): still needs making.
    const paid = await openTab({ label: 'Paid up', openedAt: new Date('2026-09-13T09:30:00Z') });
    await addItem(paid);
    await t.trx('pos_orders').where({ id: paid }).update({ status: 'settled', closed_at: new Date() });
    const voided = await openTab({ label: 'Voided', openedAt: new Date('2026-09-13T09:31:00Z') });
    await addItem(voided);
    await t.trx('pos_orders').where({ id: voided }).update({ status: 'void', closed_at: new Date() });
    const done = await openTab({ label: 'Already made', openedAt: new Date('2026-09-13T09:32:00Z') });
    await addItem(done);
    await t.trx('pos_orders').where({ id: done }).update({ ticket_done_at: new Date() });

    const res = await get();
    expect(res.status).toBe(200);
    const tickets = ours(res.body.data, [later, earlier, empty, paid, voided, done]);
    expect(tickets.map((row) => [row.table_label, row.status])).toEqual([
      ['Paid up', 'settled'],
      ['Rooftop 4', 'open'],
      ['Window 2', 'open'],
    ]);
    const rooftop = tickets[1];
    const outlet = await t.trx('pos_outlets').where({ id: outletId }).first('name');
    expect(rooftop.outlet_name).toBe(outlet.name);
    expect(rooftop.source).toBe('staff');
    expect(rooftop.guest_status).toBeNull();
    const menuItem = await t.trx('pos_menu_items').where({ id: menuItemId }).first('name');
    expect(rooftop.items).toEqual([expect.objectContaining({ quantity: 2, name: menuItem.name })]);
  });

  it('shows guest QR orders once paid, flagging ones still awaiting acceptance, and never unpaid ones or ones already on the way', async () => {
    const unpaid = await guestOrder({ label: '6', openedAt: new Date('2026-09-13T11:00:00Z'), status: 'awaiting_payment' });
    const unaccepted = await guestOrder({ label: '7', openedAt: new Date('2026-09-13T11:01:00Z'), status: 'received' });
    const preparing = await guestOrder({ label: '8', openedAt: new Date('2026-09-13T11:02:00Z'), status: 'preparing' });
    const onTheWay = await guestOrder({ label: 'Room 204', openedAt: new Date('2026-09-13T11:03:00Z'), status: 'on_the_way' });
    // Paid guest orders are settled straight away, as in the real flow.
    await t.trx('pos_orders').whereIn('id', [unaccepted, preparing, onTheWay]).update({ status: 'settled', closed_at: new Date() });

    const tickets = ours((await get()).body.data, [unpaid, unaccepted, preparing, onTheWay]);
    expect(tickets.map((row) => [row.table_label, row.source, row.guest_status, row.guest_name])).toEqual([
      ['7', 'guest', 'received', 'Ada'],
      ['8', 'guest', 'preparing', 'Ada'],
    ]);
  });

  it('marks a ticket done so it leaves the queue, and a newly added item brings it back', async () => {
    const tab = await openTab({ label: 'Bump me', openedAt: new Date('2026-09-13T13:00:00Z') });
    await addItem(tab);

    const done = await t.request.post(`/api/v1/pos/tickets/${tab}/done`).set('Authorization', `Bearer ${operator()}`);
    expect(done.status).toBe(200);
    expect(done.body.data.ticket_done_at).toBeTruthy();
    expect(String(done.body.data.ticket_done_by_user_id)).toBe(String(ctx.a.users[1].id));
    expect(ours((await get()).body.data, [tab])).toEqual([]);

    // Marking it again is harmless and keeps the first "done by".
    const again = await t.request.post(`/api/v1/pos/tickets/${tab}/done`).set('Authorization', `Bearer ${manager()}`);
    expect(again.status).toBe(200);
    expect(String(again.body.data.ticket_done_by_user_id)).toBe(String(ctx.a.users[1].id));

    const added = await t.request.post(`/api/v1/pos/orders/${tab}/items`).set('Authorization', `Bearer ${operator()}`).send({ menu_item_id: menuItemId, quantity: 1 });
    expect(added.status).toBe(200);
    expect(ours((await get()).body.data, [tab]).map((row) => row.items.length)).toEqual([2]);
  });

  it('refuses to mark done a guest order not yet accepted, a void tab, or a missing one', async () => {
    const unaccepted = await guestOrder({ label: '9', openedAt: new Date('2026-09-13T14:00:00Z'), status: 'received' });
    const refused = await t.request.post(`/api/v1/pos/tickets/${unaccepted}/done`).set('Authorization', `Bearer ${operator()}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Accept this guest order/);

    const accepted = await guestOrder({ label: '10', openedAt: new Date('2026-09-13T14:01:00Z'), status: 'preparing' });
    expect((await t.request.post(`/api/v1/pos/tickets/${accepted}/done`).set('Authorization', `Bearer ${operator()}`)).status).toBe(200);

    const voided = await openTab({ label: 'Gone', openedAt: new Date('2026-09-13T14:02:00Z') });
    await t.trx('pos_orders').where({ id: voided }).update({ status: 'void' });
    expect((await t.request.post(`/api/v1/pos/tickets/${voided}/done`).set('Authorization', `Bearer ${operator()}`)).status).toBe(409);
    expect((await t.request.post('/api/v1/pos/tickets/999999999/done').set('Authorization', `Bearer ${operator()}`)).status).toBe(404);
  });

  it('filters by outlet', async () => {
    const bar = await openTab({ label: 'Bar tab', openedAt: new Date('2026-09-13T12:00:00Z') });
    await addItem(bar);
    const kitchen = await openTab({ label: 'Kitchen tab', openedAt: new Date('2026-09-13T12:01:00Z'), outlet: secondOutletId });
    await addItem(kitchen, { item: secondMenuItemId });

    const kitchenOnly = (await get(`?outlet_id=${secondOutletId}`)).body.data;
    expect(kitchenOnly.map((row) => row.table_label)).toEqual(['Kitchen tab']);
    expect(kitchenOnly[0]).toMatchObject({ outlet_name: 'Kitchen', items: [expect.objectContaining({ name: 'Jollof Rice', category: 'Mains' })] });
    expect(ours((await get()).body.data, [bar, kitchen])).toHaveLength(2);
  });

  it('needs pos.operate', async () => {
    await setRole(ctx.a, 0, 'housekeeping');
    expect((await get('', tokenFor(ctx.a, ctx.a.users[0].id))).status).toBe(403);
    await setRole(ctx.a, 0, 'manager');
  });

  it("never shows another tenant's tabs", async () => {
    await setRole(ctx.b, 1, 'pos_operator');
    const res = await get('', tokenFor(ctx.b, ctx.b.users[1].id));
    expect(res.status).toBe(200);
    expect(res.body.data.every((row) => !/Rooftop|Window|Kitchen tab|Bar tab/.test(row.table_label ?? ''))).toBe(true);
    // Tenant B cannot mark tenant A's ticket done.
    const tab = await openTab({ label: 'Tenant A only', openedAt: new Date('2026-09-13T15:00:00Z') });
    expect((await t.request.post(`/api/v1/pos/tickets/${tab}/done`).set('Authorization', `Bearer ${tokenFor(ctx.b, ctx.b.users[1].id)}`)).status).toBe(404);
    // Filtering by tenant A's outlet id from tenant B returns nothing.
    expect((await get(`?outlet_id=${secondOutletId}`, tokenFor(ctx.b, ctx.b.users[1].id))).body.data).toEqual([]);
  });
});
