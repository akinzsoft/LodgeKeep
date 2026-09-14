'use strict';

/**
 * Staff in-app notifications (gap closure: the bell only ever received one
 * rare event type, and every signed-in user got it). Covers:
 *   - recipient resolution by role, defaults plus per-property overrides;
 *   - deactivated users never notified;
 *   - dedup keys make a repeated alert a no-op;
 *   - the bell's unread count, cap, and mark-all-read;
 *   - the Setup grid endpoints (catalogue, rules) and their RBAC;
 *   - real call sites: bookings, check-in/out and dirty rooms, stock
 *     threshold crossings, a paid guest QR order's pop-up alert, and the
 *     departing-with-balance sweep.
 *
 * Fixture roles at tenant a, properties[0]: users[0] manager, users[1]
 * housekeeping (tests/helpers/fixtures.js).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { scopedDb } = require('../../src/db');
const { contextFromSession, workerContext } = require('../../src/modules/tenancy');
const {
  effectiveRoles,
  notifyStaff,
  NOTIFICATION_EVENTS,
} = require('../../src/modules/notifications/staff-notifications');
const { notifyGuestOrderReceived } = require('../../src/modules/qr-ordering/staff-alert');
const stockService = require('../../src/modules/stock/service');
const reservationsService = require('../../src/modules/reservations/service');
const { runDepartingBalanceSweep, departingBalanceDedupKey } = require('../../src/jobs/notifications-sweep');

describe('effectiveRoles (pure)', () => {
  it('starts from the catalogue defaults', () => {
    expect([...effectiveRoles('room.became_dirty', [])].sort()).toEqual(['housekeeping', 'manager']);
  });

  it('adds enabled overrides and removes disabled ones, ignoring other event types', () => {
    const roles = effectiveRoles('room.became_dirty', [
      { event_type: 'room.became_dirty', role: 'manager', enabled: false },
      { event_type: 'room.became_dirty', role: 'front_desk', enabled: true },
      { event_type: 'guest.checked_in', role: 'cashier', enabled: true },
    ]);
    expect([...roles].sort()).toEqual(['front_desk', 'housekeeping']);
  });

  it('gives new guest QR orders to POS operator, manager, and super admin by default', () => {
    expect([...effectiveRoles('qr_ordering.guest_order_placed', [])].sort()).toEqual(['manager', 'pos_operator', 'super_admin']);
  });

  it('has a unique, labelled catalogue entry per type', () => {
    const types = NOTIFICATION_EVENTS.map((event) => event.eventType);
    expect(new Set(types).size).toBe(types.length);
    NOTIFICATION_EVENTS.forEach((event) => {
      expect(event.label).toBeTruthy();
      expect(event.group).toBeTruthy();
    });
  });
});

describe('Staff notifications (real MySQL)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  function staffContext(tenant = ctx.a, propertyIndex = 0, userIndex = 0) {
    return contextFromSession({
      tenantId: tenant.id,
      userId: tenant.users[userIndex].id,
      propertyId: tenant.properties[propertyIndex].id,
    });
  }

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function setRole(tenant, userIndex, propertyIndex, role) {
    await t
      .trx('user_property_access')
      .where({ user_id: tenant.users[userIndex].id, property_id: tenant.properties[propertyIndex].id })
      .update({ role });
  }

  async function rowsFor(tenant, type) {
    return t.trx('in_app_notifications').where({ tenant_id: tenant.id, type });
  }

  async function clearNotifications() {
    await t.trx('in_app_notifications').del();
    await t.trx('notification_role_rules').whereNot({ event_type: 'pos.order_settled' }).del();
  }

  beforeEach(clearNotifications);

  describe('recipient resolution', () => {
    it('notifies exactly the users holding a default role at that property', async () => {
      const db = scopedDb().for(staffContext());
      await notifyStaff({ trx: db, eventType: 'room.became_dirty', payload: { roomNumber: '01' } });
      const rows = await rowsFor(ctx.a, 'room.became_dirty');
      expect(rows.map((row) => String(row.user_id)).sort()).toEqual([String(ctx.a.users[0].id), String(ctx.a.users[1].id)].sort());

      await notifyStaff({ trx: db, eventType: 'guest.checked_in', payload: {} });
      const checkIns = await rowsFor(ctx.a, 'guest.checked_in');
      expect(checkIns.map((row) => String(row.user_id))).toEqual([String(ctx.a.users[0].id)]);
      expect(await rowsFor(ctx.b, 'guest.checked_in')).toHaveLength(0);
    });

    it('applies a saved override for this property only', async () => {
      await t.trx('notification_role_rules').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        event_type: 'room.became_dirty',
        role: 'manager',
        enabled: false,
      });
      await notifyStaff({ trx: scopedDb().for(staffContext()), eventType: 'room.became_dirty', payload: {} });
      const rows = await rowsFor(ctx.a, 'room.became_dirty');
      expect(rows.map((row) => String(row.user_id))).toEqual([String(ctx.a.users[1].id)]);
    });

    it('never notifies a deactivated user', async () => {
      await t.trx('users').where({ id: ctx.a.users[1].id }).update({ status: 'inactive' });
      try {
        await notifyStaff({ trx: scopedDb().for(staffContext()), eventType: 'room.became_dirty', payload: {} });
        const rows = await rowsFor(ctx.a, 'room.became_dirty');
        expect(rows.map((row) => String(row.user_id))).toEqual([String(ctx.a.users[0].id)]);
      } finally {
        await t.trx('users').where({ id: ctx.a.users[1].id }).update({ status: 'active' });
      }
    });

    it('a repeated dedup key writes nothing new', async () => {
      const db = scopedDb().for(staffContext());
      const first = await notifyStaff({ trx: db, eventType: 'room.became_dirty', payload: {}, dedupKey: 'same-key' });
      const second = await notifyStaff({ trx: db, eventType: 'room.became_dirty', payload: {}, dedupKey: 'same-key' });
      expect(first).toBe(2);
      expect(second).toBe(0);
      expect(await rowsFor(ctx.a, 'room.became_dirty')).toHaveLength(2);
    });

    it('rejects an unknown event type (a programming error, not silent)', async () => {
      await expect(notifyStaff({ trx: scopedDb().for(staffContext()), eventType: 'nope', payload: {} })).rejects.toThrow(/unknown/);
    });
  });

  describe('bell endpoints', () => {
    it('returns the true unread count and caps the list at 50', async () => {
      const rows = Array.from({ length: 55 }, () => ({
        tenant_id: ctx.a.id,
        user_id: ctx.a.users[0].id,
        type: 'guest.checked_in',
        payload: JSON.stringify({}),
      }));
      await t.trx('in_app_notifications').insert(rows);
      const res = await t.request.get('/api/v1/notifications/bell').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(50);
      expect(res.body.meta.unreadCount).toBe(55);
    });

    it('marks all of my notifications read and leaves other users\' alone', async () => {
      await t.trx('in_app_notifications').insert([
        { tenant_id: ctx.a.id, user_id: ctx.a.users[0].id, type: 'guest.checked_in', payload: '{}' },
        { tenant_id: ctx.a.id, user_id: ctx.a.users[0].id, type: 'guest.checked_out', payload: '{}' },
        { tenant_id: ctx.a.id, user_id: ctx.a.users[1].id, type: 'room.became_dirty', payload: '{}' },
      ]);
      const res = await t.request.post('/api/v1/notifications/bell/read-all').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(2);
      const others = await t.trx('in_app_notifications').where({ user_id: ctx.a.users[1].id }).whereNull('read_at');
      expect(others).toHaveLength(1);
    });
  });

  describe('Setup grid endpoints', () => {
    it('manager can read the catalogue and rules but not change them', async () => {
      const catalogue = await t.request.get('/api/v1/notifications/catalogue').set('Authorization', `Bearer ${tokenFor()}`);
      expect(catalogue.status).toBe(200);
      expect(catalogue.body.data.map((event) => event.eventType)).toContain('qr_ordering.guest_order_placed');

      const rules = await t.request.get('/api/v1/notifications/role-rules').set('Authorization', `Bearer ${tokenFor()}`);
      expect(rules.status).toBe(200);

      const attempt = await t.request
        .put('/api/v1/notifications/role-rules')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ rules: [{ eventType: 'room.became_dirty', role: 'front_desk', enabled: true }] });
      expect(attempt.status).toBe(403);
    });

    it('a role without notifications.view cannot read the rules', async () => {
      const res = await t.request
        .get('/api/v1/notifications/role-rules')
        .set('Authorization', `Bearer ${tokenFor({ userId: ctx.a.users[1].id })}`);
      expect(res.status).toBe(403);
    });

    it('admin saves overrides (upsert, audited) and they drive who is notified', async () => {
      await setRole(ctx.a, 1, 0, 'admin');
      try {
        const adminToken = tokenFor({ userId: ctx.a.users[1].id });
        const first = await t.request
          .put('/api/v1/notifications/role-rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ rules: [{ eventType: 'guest.checked_in', role: 'admin', enabled: true }] });
        expect(first.status).toBe(200);
        expect(first.body.data).toContainEqual({ eventType: 'guest.checked_in', role: 'admin', enabled: true });

        const second = await t.request
          .put('/api/v1/notifications/role-rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ rules: [{ eventType: 'guest.checked_in', role: 'admin', enabled: false }] });
        expect(second.status).toBe(200);
        const stored = await t.trx('notification_role_rules').where({ tenant_id: ctx.a.id, event_type: 'guest.checked_in', role: 'admin' });
        expect(stored).toHaveLength(1);
        expect(Boolean(stored[0].enabled)).toBe(false);

        const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'notification_role_rules' });
        expect(audit.length).toBeGreaterThanOrEqual(2);

        await t.request
          .put('/api/v1/notifications/role-rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ rules: [{ eventType: 'guest.checked_in', role: 'admin', enabled: true }] });
        await notifyStaff({ trx: scopedDb().for(staffContext()), eventType: 'guest.checked_in', payload: {} });
        const recipients = (await rowsFor(ctx.a, 'guest.checked_in')).map((row) => String(row.user_id)).sort();
        expect(recipients).toEqual([String(ctx.a.users[0].id), String(ctx.a.users[1].id)].sort());
      } finally {
        await setRole(ctx.a, 1, 0, 'housekeeping');
      }
    });

    it('rejects an unknown event type or role without writing anything', async () => {
      await setRole(ctx.a, 1, 0, 'admin');
      try {
        const adminToken = tokenFor({ userId: ctx.a.users[1].id });
        const badType = await t.request
          .put('/api/v1/notifications/role-rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            rules: [
              { eventType: 'room.became_dirty', role: 'front_desk', enabled: true },
              { eventType: 'not.real', role: 'front_desk', enabled: true },
            ],
          });
        expect(badType.status).toBe(400);
        const badRole = await t.request
          .put('/api/v1/notifications/role-rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ rules: [{ eventType: 'room.became_dirty', role: 'owner', enabled: true }] });
        expect(badRole.status).toBe(400);
        const stored = await t.trx('notification_role_rules').where({ tenant_id: ctx.a.id, event_type: 'room.became_dirty' });
        expect(stored).toHaveLength(0);
      } finally {
        await setRole(ctx.a, 1, 0, 'housekeeping');
      }
    });

    it("never shows or changes another tenant's rules", async () => {
      await t.trx('notification_role_rules').insert({
        tenant_id: ctx.b.id,
        property_id: ctx.b.properties[0].id,
        event_type: 'room.became_dirty',
        role: 'cashier',
        enabled: true,
      });
      const res = await t.request.get('/api/v1/notifications/role-rules').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.body.data).not.toContainEqual({ eventType: 'room.became_dirty', role: 'cashier', enabled: true });
    });
  });

  describe('call sites', () => {
    it('booking, check-in, and check-out notify front desk roles; check-out also flags the room dirty', async () => {
      const property = ctx.a.properties[0];
      await t.trx('properties').where({ id: property.id }).update({ current_business_date: '2026-12-24' });
      const db = scopedDb().for(staffContext());

      const created = await db.transaction((trx) =>
        reservationsService.createReservation({
          trx,
          guestId: ctx.a.guests[0].id,
          roomTypeId: ctx.a.roomTypes[0].id,
          rateCodeId: ctx.a.rateCodes[0].id,
          arrivalDate: '2027-02-01',
          departureDate: '2027-02-02',
          adults: 1,
          children: 0,
        })
      );
      const [booking] = await rowsFor(ctx.a, 'reservation.created');
      expect(booking).toBeDefined();
      const bookingPayload = typeof booking.payload === 'string' ? JSON.parse(booking.payload) : booking.payload;
      expect(String(bookingPayload.reservationId)).toBe(String(created.id));
      expect(bookingPayload.guestName).toBeTruthy();

      await db.transaction((trx) => reservationsService.cancelReservation({ trx, id: created.id, reason: 'test' }));
      expect(await rowsFor(ctx.a, 'reservation.cancelled')).toHaveLength(1);

      // A fresh stay arriving today: check it in to a free room, then out.
      await t.trx('properties').where({ id: property.id }).update({ current_business_date: '2027-03-01' });
      const stay = await db.transaction((trx) =>
        reservationsService.createReservation({
          trx,
          guestId: ctx.a.guests[0].id,
          roomTypeId: ctx.a.roomTypes[0].id,
          rateCodeId: ctx.a.rateCodes[0].id,
          arrivalDate: '2027-03-01',
          departureDate: '2027-03-02',
          adults: 1,
          children: 0,
        })
      );
      const [freeRoomId] = await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: property.id,
        room_number: 'N1',
        floor: '1',
        room_type_id: ctx.a.roomTypes[0].id,
      });
      const freeRoom = await t.trx('rooms').where({ id: freeRoomId }).first();
      await db.transaction((trx) => reservationsService.checkIn({ trx, id: stay.id, roomId: freeRoom.id, overrideDirty: true }));
      const [checkIn] = await rowsFor(ctx.a, 'guest.checked_in');
      const checkInPayload = typeof checkIn.payload === 'string' ? JSON.parse(checkIn.payload) : checkIn.payload;
      expect(checkInPayload.roomNumber).toBe(freeRoom.room_number);

      await db.transaction((trx) => reservationsService.checkOut({ trx, id: stay.id }));

      expect(await rowsFor(ctx.a, 'guest.checked_out')).toHaveLength(1);
      const dirty = await rowsFor(ctx.a, 'room.became_dirty');
      expect(dirty.map((row) => String(row.user_id)).sort()).toEqual([String(ctx.a.users[0].id), String(ctx.a.users[1].id)].sort());
      const dirtyPayload = typeof dirty[0].payload === 'string' ? JSON.parse(dirty[0].payload) : dirty[0].payload;
      expect(dirtyPayload.reason).toBe('check_out');
    });

    it('stock alerts fire on the crossing only, not on every later decrement', async () => {
      const db = scopedDb().for(staffContext());
      const stockItemId = ctx.a.stockItems[0].id;
      const before = await t.trx('stock_items').where({ id: stockItemId }).first();
      // Take it to just below its reorder level (500), from 1000.
      const toBelowReorder = (Number(before.current_quantity) - 400).toFixed(3);
      await db.transaction((trx) =>
        stockService.recordWastage({ trx, stockItemId, quantity: toBelowReorder, reason: 'Spill', userId: ctx.a.users[0].id, businessDate: '2026-12-24' })
      );
      expect(await rowsFor(ctx.a, 'stock.reorder_level_reached')).toHaveLength(1);

      await db.transaction((trx) =>
        stockService.recordWastage({ trx, stockItemId, quantity: '100.000', reason: 'Spill', userId: ctx.a.users[0].id, businessDate: '2026-12-24' })
      );
      expect(await rowsFor(ctx.a, 'stock.reorder_level_reached')).toHaveLength(1);
      expect(await rowsFor(ctx.a, 'stock.out_of_stock')).toHaveLength(0);

      await db.transaction((trx) =>
        stockService.recordWastage({ trx, stockItemId, quantity: '300.000', reason: 'Spill', userId: ctx.a.users[0].id, businessDate: '2026-12-24' })
      );
      const outRows = await rowsFor(ctx.a, 'stock.out_of_stock');
      expect(outRows).toHaveLength(1);
      const payload = typeof outRows[0].payload === 'string' ? JSON.parse(outRows[0].payload) : outRows[0].payload;
      expect(payload.name).toBe('Fixture Vodka');
      expect(payload.quantity).toBe('0.000');
      expect(await rowsFor(ctx.a, 'stock.reorder_level_reached')).toHaveLength(1);
    });

    it('a paid guest QR order raises a pop-up alert naming who ordered, what, where, and the total', async () => {
      const guestOrder = ctx.a.posGuestOrders[0];
      await t.trx('pos_guest_orders').where({ id: guestOrder.id }).update({ guest_name: 'John' });
      await setRole(ctx.a, 1, 0, 'pos_operator');
      try {
        const db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id }));
        await notifyGuestOrderReceived({ db, guestOrderId: guestOrder.id, total: '21.50', currency: 'NGN' });
        const rows = await rowsFor(ctx.a, 'qr_ordering.guest_order_placed');
        expect(rows.map((row) => String(row.user_id)).sort()).toEqual([String(ctx.a.users[0].id), String(ctx.a.users[1].id)].sort());
        expect(rows.every((row) => Boolean(row.popup))).toBe(true);
        const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
        expect(payload).toMatchObject({ guestName: 'John', total: '21.50', currency: 'NGN', paymentMethod: 'card' });
        expect(payload.tableLabel).toBeTruthy();
        expect(Array.isArray(payload.items)).toBe(true);
      } finally {
        await setRole(ctx.a, 1, 0, 'housekeeping');
      }
    });

    it('the sweep alerts once per departing guest per business date, and not after the balance is cleared', async () => {
      const property = ctx.a.properties[0];
      const reservationId = ctx.a.reservations[0].id;
      await t.trx('properties').where({ id: property.id }).update({ current_business_date: '2026-12-26' });
      await t.trx('reservations').where({ id: reservationId }).update({ status: 'checked_in' });
      await t.trx('folios').where({ reservation_id: reservationId }).update({ status: 'open', balance: '150.00' });

      await runDepartingBalanceSweep();
      await runDepartingBalanceSweep();
      const rows = await rowsFor(ctx.a, 'front_desk.departing_balance_outstanding');
      expect(rows.map((row) => String(row.user_id))).toEqual([String(ctx.a.users[0].id)]);
      expect(rows[0].dedup_key).toBe(departingBalanceDedupKey(reservationId, '2026-12-26'));
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      expect(payload).toMatchObject({ balance: '150.00', currency: 'NGN' });

      await t.trx('in_app_notifications').del();
      await t.trx('folios').where({ reservation_id: reservationId }).update({ balance: '0.00' });
      await runDepartingBalanceSweep();
      expect(await rowsFor(ctx.a, 'front_desk.departing_balance_outstanding')).toHaveLength(0);
    });
  });
});
