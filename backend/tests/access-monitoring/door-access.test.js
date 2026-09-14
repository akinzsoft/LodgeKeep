'use strict';

/**
 * HTTP-level tests for door access monitoring — PLAN.md Phase 7,
 * PRODUCT_REQUIREMENTS.md §3.23, TESTING.md LOCK-* where they map to the
 * confirmed manual_import scope.
 *
 * Occupancy history is seeded directly as `reservations` + `reservation_rooms`
 * rows with chosen past instants — exactly the shape checkIn/roomMove/checkOut
 * write — because a retrospective import is about events days old, which the
 * real endpoints (always "now") cannot produce.
 *
 * Tenant A's properties[0] is in Africa/Lagos (UTC+1, no DST): every file
 * timestamp below is Lagos wall-clock time, one hour ahead of the UTC
 * instants asserted against.
 *
 * Cross-tenant isolation for every new table comes from tests/isolation's
 * ISO-* suite via tests/helpers/entities.js.
 */

const XLSX = require('xlsx');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { purgeExpiredEvents } = require('../../src/modules/access-monitoring/service');
const { workerContext } = require('../../src/modules/tenancy');

const BASE_MAPPING = { roomColumn: 'Door', cardColumn: 'Card', timestampColumn: 'Time', timestampFormat: 'YYYY-MM-DD HH:mm:ss' };

/** Lagos wall-clock "YYYY-MM-DD HH:mm:ss" → the UTC Date it denotes. */
function lagos(text) {
  return new Date(`${text.replace(' ', 'T')}+01:00`);
}

function csv(rows, header = 'Door,Card,Time') {
  return Buffer.from([header, ...rows.map((r) => r.join(','))].join('\n'));
}

describe('Door access monitoring (PLAN.md Phase 7)', () => {
  const t = useTestApp();
  let ctx;
  let roomTypeId;
  let confirmationSeq = 0;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    const [id] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'DOORTYPE',
      name: 'Door test',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    roomTypeId = id;
  });

  function tokenFor({ tenant = ctx.a, userIndex = 0, propertyIndex = 0 } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[propertyIndex].id),
    });
  }
  const manager = () => tokenFor();

  async function createRoom(roomNumber) {
    const [id] = await t.trx('rooms').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      room_type_id: roomTypeId,
      room_number: roomNumber,
    });
    return id;
  }

  /** A reservation plus one room assignment [from, to). */
  async function seedStay({ roomId, from, to = null, status, reservationId = null }) {
    let id = reservationId;
    if (!id) {
      confirmationSeq += 1;
      [id] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: ctx.a.guests[0].id,
        room_type_id: roomTypeId,
        rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: '2026-03-01',
        departure_date: '2026-03-10',
        adults: 1,
        children: 0,
        status,
        confirmation_number: `DOOR-${confirmationSeq}`,
        checked_in_at: from,
        checked_out_at: status === 'checked_out' ? to : null,
      });
    }
    const [assignmentId] = await t.trx('reservation_rooms').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      reservation_id: id,
      room_id: roomId,
      effective_from: from,
      effective_to: to,
    });
    return { reservationId: id, assignmentId };
  }

  function upload(path, buffer, { mapping, token = manager(), filename = 'audit.csv' } = {}) {
    let req = t.request.post(`/api/v1/door-access/imports/${path}`).set('Authorization', `Bearer ${token}`);
    if (mapping) req = req.field('mapping', JSON.stringify(mapping));
    return req.attach('file', buffer, filename);
  }
  const commit = (buffer, mapping = BASE_MAPPING, opts) => upload('commit', buffer, { mapping, ...opts });

  const alertsFor = (roomId) => t.trx('access_alerts').where({ tenant_id: ctx.a.id, room_id: roomId }).orderBy('id');

  // ====================================================================
  describe('RBAC and plan entitlement', () => {
    it('manager reads config; housekeeping and front desk are refused (§3.23: never the people who could commit the fraud)', async () => {
      const ok = await t.request.get('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ adapter: 'hiread_prousb', supportsRealtime: false, timezone: 'Africa/Lagos' });

      const housekeeping = await t.request.get('/api/v1/door-access/alerts').set('Authorization', `Bearer ${tokenFor({ userIndex: 1 })}`);
      expect(housekeeping.status).toBe(403);
      const frontDesk = await t.request.get('/api/v1/door-access/alerts').set('Authorization', `Bearer ${tokenFor({ propertyIndex: 1 })}`);
      expect(frontDesk.status).toBe(403);
    });

    it('a tenant whose plan lacks door_access_monitoring is refused on every route, even a super_admin', async () => {
      const [planId] = await t.trx('plans').insert({ code: 'no-door-access-test', name: 'No door access', price: '1.00', currency: 'NGN', billing_interval: 'monthly', is_active: true });
      await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role: 'super_admin' });
      await t.trx('tenants').where({ id: ctx.a.id }).update({ plan_id: planId });
      try {
        const res = await t.request.get('/api/v1/door-access/alerts').set('Authorization', `Bearer ${manager()}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatchObject({ code: 'FORBIDDEN_PLAN_ENTITLEMENT', details: { featureKey: 'door_access_monitoring', planCode: 'no-door-access-test' } });
      } finally {
        await t.trx('tenants').where({ id: ctx.a.id }).update({ plan_id: null });
        await t.trx('user_property_access').where({ user_id: ctx.a.users[0].id, property_id: ctx.a.properties[0].id }).update({ role: 'manager' });
      }
    });
  });

  // ====================================================================
  describe('configuration and the import flow', () => {
    it('refuses an import while the lock system is "none", and validates settings', async () => {
      const none = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ adapter: 'none' });
      expect(none.status).toBe(200);
      const refused = await commit(csv([['101', 'X', '2026-03-04 10:00:00']]));
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_LOCK_SYSTEM_NOT_CONFIGURED');

      const bad = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ adapter: 'salto' });
      expect(bad.status).toBe(400);

      const back = await t.request
        .put('/api/v1/door-access/config')
        .set('Authorization', `Bearer ${manager()}`)
        .send({ adapter: 'hiread_prousb', post_checkout_grace_minutes: 15 });
      expect(back.body.data).toMatchObject({ adapter: 'hiread_prousb', ingestionMode: 'manual_import', postCheckoutGraceMinutes: 15 });
    });

    it('returns the file\'s real headers and distinct values; preview writes nothing and reports duplicates, unmatched rooms and bad rows', async () => {
      const roomId = await createRoom('P1');
      const file = csv(
        [
          ['P1', 'G1', 'Guest', '2026-03-04 10:00:00'],
          ['p1', 'G1', 'Guest', '2026-03-04 10:00:00'], // duplicate within the file
          ['NOPE', 'G1', 'Guest', '2026-03-04 10:00:00'],
          ['P1', 'G2', 'Guest', 'not a time'],
          ['P1', 'M1', 'Master', '2026-03-04 11:00:00'],
        ],
        'Door,Card,Card Type,Time'
      );

      const headers = await upload('headers', file);
      expect(headers.status).toBe(200);
      expect(headers.body.data.headers).toEqual(['Door', 'Card', 'Card Type', 'Time']);
      expect(headers.body.data.distinctValues['Card Type'].values).toEqual(['Guest', 'Master']);
      expect(headers.body.data.timestampFormats).toContain('DD/MM/YYYY HH:mm:ss');

      const before = await t.trx('door_access_events').where({ room_id: roomId }).count({ n: '*' });
      const preview = await upload('preview', file, { mapping: { ...BASE_MAPPING, cardTypeColumn: 'Card Type', guestCardTypeValues: ['Guest'] } });
      expect(preview.status).toBe(200);
      expect(preview.body.data).toMatchObject({
        rowCount: 5,
        newEventCount: 2,
        duplicatesInFile: 1,
        unparseableCount: 1,
        unmatchedRooms: [{ identifier: 'NOPE', count: 1 }],
        cardTypeColumnMapped: true,
        guestEventCount: 1,
        nonGuestEventCount: 1,
        supportsRealtime: false,
      });
      const after = await t.trx('door_access_events').where({ room_id: roomId }).count({ n: '*' });
      expect(after).toEqual(before);
    });

    it('rejects a mapping that names a column absent from this file', async () => {
      const res = await upload('preview', csv([['101', 'X', '2026-03-04 10:00:00']]), { mapping: { ...BASE_MAPPING, cardColumn: 'Card No' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_DOOR_ACCESS_MAPPING_INVALID');
    });
  });

  // ====================================================================
  describe('rules', () => {
    it('LOCK-4 unsold_occupancy: a guest card in a room with no stay raises ONE critical incident for consecutive opens, stored as UTC, retrospective', async () => {
      const roomId = await createRoom('U1');
      const res = await commit(csv([['U1', 'CARD-U', '2026-03-04 23:05:00'], ['U1', 'CARD-U', '2026-03-05 01:30:00']]));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ eventsStored: 2, alertsCreated: 1, criticalAlertsCreated: 1, supportsRealtime: false });

      const events = await t.trx('door_access_events').where({ room_id: roomId }).orderBy('opened_at');
      expect(events.map((e) => e.opened_at.toISOString())).toEqual(['2026-03-04T22:05:00.000Z', '2026-03-05T00:30:00.000Z']);
      expect(events.every((e) => e.is_retrospective)).toBe(true); // LOCK-9

      const alerts = await alertsFor(roomId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ rule: 'unsold_occupancy', severity: 'critical', status: 'open', event_count: 2, business_date: '2026-03-04' });
      expect(alerts[0].evidence).toMatchObject({ retrospective: true, previousStay: null, roomAtDetection: { roomNumber: 'U1' } });
      const links = await t.trx('access_alert_events').where({ access_alert_id: alerts[0].id });
      expect(links).toHaveLength(2);
    });

    it('LOCK-14: notifies manager/admin/super_admin only — one bell row per new incident and one digest email per recipient', async () => {
      await createRoom('N1');
      const [frontDeskUserId] = await t.trx('users').insert({
        tenant_id: ctx.a.id,
        email: 'desk@example.com',
        password_hash: `$2b$12$${'x'.repeat(53)}`,
        first_name: 'Desk',
        last_name: 'Clerk',
        status: 'active',
      });
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, user_id: frontDeskUserId, role: 'front_desk' });
      const res = await commit(csv([['N1', 'CARD-N', '2026-03-06 02:00:00']]));
      expect(res.body.data.notifiedRecipientCount).toBe(1);

      const bell = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id, type: 'door_access.critical_alert_raised' });
      const bellUsers = new Set(bell.map((b) => String(b.user_id)));
      expect(bellUsers.has(String(ctx.a.users[0].id))).toBe(true); // manager
      expect(bellUsers.has(String(ctx.a.users[1].id))).toBe(false); // housekeeping
      expect(bellUsers.has(String(frontDeskUserId))).toBe(false); // front desk

      const outbox = await t.trx('outbox_events')
        .where({ tenant_id: ctx.a.id, event_type: 'door_access.critical_alerts_detected' })
        .orderBy('id', 'desc')
        .first();
      const payload = typeof outbox.payload === 'string' ? JSON.parse(outbox.payload) : outbox.payload;
      expect(payload).toMatchObject({ recipientEmail: 'sam@example.com', criticalAlertCount: 1, alertSummary: 'Room N1 — unsold occupancy', earliestEventDate: '2026-03-06' });
    });

    it('LOCK-5 post_checkout_access: after checkout + grace is critical; within grace is ignored', async () => {
      const roomId = await createRoom('C1');
      const checkout = lagos('2026-03-04 11:00:00');
      await seedStay({ roomId, from: lagos('2026-03-02 14:00:00'), to: checkout, status: 'checked_out' });

      const res = await commit(csv([['C1', 'CARD-C', '2026-03-04 11:10:00'], ['C1', 'CARD-C', '2026-03-04 11:40:00']]));
      expect(res.body.data).toMatchObject({ ignoredWithinGrace: 1, alertsCreated: 1 });
      const [alert] = await alertsFor(roomId);
      expect(alert).toMatchObject({ rule: 'post_checkout_access', severity: 'critical', event_count: 1 });
      expect(alert.evidence.previousStay).toMatchObject({ vacatedBy: 'checkout', reservationStatus: 'checked_out', confirmationNumber: expect.stringMatching(/^DOOR-/) });
    });

    it('a room vacated by a ROOM MOVE is not a checkout — access afterwards is unsold_occupancy', async () => {
      const roomA = await createRoom('M1');
      const roomB = await createRoom('M2');
      const moved = lagos('2026-03-04 12:00:00');
      const { reservationId } = await seedStay({ roomId: roomA, from: lagos('2026-03-03 14:00:00'), to: moved, status: 'checked_in' });
      await seedStay({ roomId: roomB, from: moved, status: 'checked_in', reservationId });

      await commit(csv([['M1', 'CARD-M', '2026-03-04 15:00:00']]));
      const [alert] = await alertsFor(roomA);
      expect(alert.rule).toBe('unsold_occupancy');
      expect(alert.evidence.previousStay).toMatchObject({ vacatedBy: 'room_move' });
    });

    it('first use after check-in is recorded once per stay; later entries are not logged; an earlier pull moves "first use" earlier', async () => {
      const roomId = await createRoom('F1');
      const { reservationId } = await seedStay({ roomId, from: lagos('2026-03-04 14:00:00'), status: 'checked_in' });

      const first = await commit(csv([['F1', 'CARD-F', '2026-03-04 15:00:00'], ['F1', 'CARD-F', '2026-03-04 20:00:00']]));
      expect(first.body.data).toMatchObject({ stayConfirmationsRecorded: 1, alertsCreated: 0 });
      let rows = await t.trx('door_access_stay_confirmations').where({ reservation_id: reservationId });
      expect(rows).toHaveLength(1);
      expect(rows[0].opened_at.toISOString()).toBe('2026-03-04T14:00:00.000Z');

      const earlier = await commit(csv([['F1', 'CARD-F', '2026-03-04 14:30:00']]));
      expect(earlier.body.data.stayConfirmationsRecorded).toBe(0);
      rows = await t.trx('door_access_stay_confirmations').where({ reservation_id: reservationId });
      expect(rows).toHaveLength(1);
      expect(rows[0].opened_at.toISOString()).toBe('2026-03-04T13:30:00.000Z');
      expect(await alertsFor(roomId)).toHaveLength(0);

      const list = await t.request.get('/api/v1/door-access/stay-confirmations').set('Authorization', `Bearer ${manager()}`);
      expect(list.body.data.find((r) => String(r.reservation_id) === String(reservationId))).toMatchObject({ room_number: 'F1' });
    });

    it('staff/master cards and denied opens are stored but never evaluated', async () => {
      const roomId = await createRoom('S1');
      const res = await commit(
        csv(
          [
            ['S1', 'MASTER-1', 'Master', 'OK', '2026-03-04 10:00:00'],
            ['S1', 'GUEST-1', 'Guest', 'DENIED', '2026-03-04 10:05:00'],
          ],
          'Door,Card,Type,Result,Time'
        ),
        { ...BASE_MAPPING, cardTypeColumn: 'Type', guestCardTypeValues: ['Guest'], resultColumn: 'Result', deniedResultValues: ['DENIED'] }
      );
      expect(res.body.data).toMatchObject({ eventsStored: 2, notEvaluated: 2, alertsCreated: 0 });
      const events = await t.trx('door_access_events').where({ room_id: roomId }).orderBy('opened_at');
      expect(events.map((e) => [e.card_type, Boolean(e.is_guest_card), e.result])).toEqual([
        ['Master', false, 'granted'],
        ['Guest', true, 'denied'],
      ]);
    });

    it('reads a real .xlsx export end to end (native date cells, numeric room numbers)', async () => {
      const roomId = await createRoom('707');
      const serial = 25569 + Date.UTC(2026, 2, 7, 3, 15, 0) / 86400000;
      const sheet = XLSX.utils.aoa_to_sheet([['Lock No', 'Card ID', 'Open Time'], [707, 'XL-1', serial]]);
      sheet.C2.z = 'yyyy-mm-dd hh:mm:ss';
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Log');
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

      const res = await commit(buffer, { roomColumn: 'Lock No', cardColumn: 'Card ID', timestampColumn: 'Open Time', timestampFormat: null }, { filename: 'audit.xlsx' });
      expect(res.status).toBe(201);
      const [event] = await t.trx('door_access_events').where({ room_id: roomId });
      expect(event.opened_at.toISOString()).toBe('2026-03-07T02:15:00.000Z');
    });
  });

  // ====================================================================
  describe('re-uploads and incidents over time', () => {
    it('LOCK-8/10: re-uploading the same file stores nothing new, raises nothing and re-notifies nobody', async () => {
      const roomId = await createRoom('R1');
      const file = csv([['R1', 'CARD-R', '2026-03-08 01:00:00']]);
      await commit(file);
      const bellBefore = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id }).count({ n: '*' });

      const again = await commit(file);
      expect(again.body.data).toMatchObject({ newEventCount: 0, duplicatesAlreadyImported: 1, eventsStored: 0, alertsCreated: 0, alertsExtended: 0, notifiedRecipientCount: 0 });
      expect(await t.trx('door_access_events').where({ room_id: roomId })).toHaveLength(1);
      expect(await alertsFor(roomId)).toHaveLength(1);
      expect(await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id }).count({ n: '*' })).toEqual(bellBefore);
    });

    it('a later pull extends an open incident; after resolution, a recurrence is a fresh incident', async () => {
      const roomId = await createRoom('E1');
      await commit(csv([['E1', 'CARD-E', '2026-03-09 01:00:00']]));
      const extended = await commit(csv([['E1', 'CARD-E', '2026-03-09 03:00:00']]));
      expect(extended.body.data).toMatchObject({ alertsCreated: 0, alertsExtended: 1 });
      let alerts = await alertsFor(roomId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].event_count).toBe(2);

      const resolved = await t.request
        .post(`/api/v1/door-access/alerts/${alerts[0].id}/resolve`)
        .set('Authorization', `Bearer ${manager()}`)
        .send({ reason: 'Engineer testing the lock' });
      expect(resolved.status).toBe(200);

      await commit(csv([['E1', 'CARD-E', '2026-03-10 02:00:00']]));
      alerts = await alertsFor(roomId);
      expect(alerts.map((a) => [a.status, a.event_count])).toEqual([
        ['resolved', 2],
        ['open', 1],
      ]);
    });
  });

  // ====================================================================
  describe('alert lifecycle and reads', () => {
    let alertId;

    beforeAll(async () => {
      const roomId = await createRoom('L1');
      await commit(csv([['L1', 'CARD-L', '2026-03-11 04:00:00']]));
      [{ id: alertId }] = await alertsFor(roomId);
    });

    it('lists with filters and returns evidence, events and the room timeline', async () => {
      const list = await t.request.get('/api/v1/door-access/alerts').query({ status: 'open', rule: 'unsold_occupancy' }).set('Authorization', `Bearer ${manager()}`);
      expect(list.status).toBe(200);
      expect(list.body.data.some((a) => String(a.id) === String(alertId) && a.room_number === 'L1')).toBe(true);

      const detail = await t.request.get(`/api/v1/door-access/alerts/${alertId}`).set('Authorization', `Bearer ${manager()}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.events).toHaveLength(1);
      expect(detail.body.data.roomTimeline).toHaveLength(1);
      expect(detail.body.data.evidence.retrospective).toBe(true);
    });

    it('acknowledge → resolve requires a reason, is audited, and a resolved alert is final', async () => {
      const ack = await t.request.post(`/api/v1/door-access/alerts/${alertId}/acknowledge`).set('Authorization', `Bearer ${manager()}`);
      expect(ack.body.data).toMatchObject({ status: 'acknowledged' });

      const noReason = await t.request.post(`/api/v1/door-access/alerts/${alertId}/resolve`).set('Authorization', `Bearer ${manager()}`).send({ reason: '  ' });
      expect(noReason.status).toBe(400);

      const resolved = await t.request.post(`/api/v1/door-access/alerts/${alertId}/resolve`).set('Authorization', `Bearer ${manager()}`).send({ reason: 'Walk-in not entered in PMS; folio raised' });
      expect(resolved.body.data).toMatchObject({ status: 'resolved', resolution_reason: 'Walk-in not entered in PMS; folio raised' });

      const again = await t.request.post(`/api/v1/door-access/alerts/${alertId}/resolve`).set('Authorization', `Bearer ${manager()}`).send({ reason: 'again' });
      expect(again.status).toBe(409);

      const audit = await t.trx('audit_log').where({ tenant_id: ctx.a.id, entity_type: 'access_alerts', entity_id: alertId, action: 'resolve' });
      expect(audit).toHaveLength(1);
    });

    it('another tenant sees 404, never 403', async () => {
      const res = await t.request.get(`/api/v1/door-access/alerts/${alertId}`).set('Authorization', `Bearer ${tokenFor({ tenant: ctx.b })}`);
      expect(res.status).toBe(404);
    });
  });

  // ====================================================================
  describe('retention (gap closure, PRODUCT_REQUIREMENTS.md §3.23 legal/privacy note)', () => {
    it('validates retention_days and round-trips a real number alongside null (no automatic purge, the default)', async () => {
      const zero = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 0 });
      expect(zero.status).toBe(400);
      const tooLarge = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 3651 });
      expect(tooLarge.status).toBe(400);
      const fractional = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 2.5 });
      expect(fractional.status).toBe(400);

      const set = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 90 });
      expect(set.status).toBe(200);
      expect(set.body.data.retentionDays).toBe(90);
      const read = await t.request.get('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`);
      expect(read.body.data.retentionDays).toBe(90);

      const cleared = await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.retentionDays).toBeNull();
    });

    it('purgeExpiredEvents deletes an old, unreferenced (master-card, never-evaluated) event but keeps one that confirmed a stay, regardless of age', async () => {
      await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 30 });

      // Unreferenced: a master card is stored but never evaluated by any
      // rule, so it never becomes evidence for anything (LOCK-7).
      const masterRoomId = await createRoom('RET1');
      await commit(
        csv([['RET1', 'MASTER-RET', 'Master', '2020-01-01 10:00:00']], 'Door,Card,Type,Time'),
        { ...BASE_MAPPING, cardTypeColumn: 'Type', guestCardTypeValues: ['Guest'] }
      );

      // Referenced: a guest card opening a covered, checked-in stay
      // becomes a stay confirmation — kept regardless of age.
      const stayRoomId = await createRoom('RET2');
      const { reservationId } = await seedStay({ roomId: stayRoomId, from: lagos('2020-01-02 09:00:00'), status: 'checked_in' });
      await commit(csv([['RET2', 'CARD-RET', '2020-01-02 10:00:00']]));
      expect(await t.trx('door_access_stay_confirmations').where({ reservation_id: reservationId })).toHaveLength(1);

      // Not asserting an exact deleted count: this shared-transaction harness
      // accumulates events from every earlier describe block in this file,
      // most of them dated 2026-03-xx — genuinely older than 30 real days
      // before whatever the actual system clock reads when this suite runs,
      // so they are legitimately swept up alongside the two rows this test
      // itself created. The two room-scoped checks below are what this test
      // is actually about, and are correct regardless of that backlog.
      const result = await purgeExpiredEvents({ context: workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id }) });
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      expect(await t.trx('door_access_events').where({ room_id: masterRoomId })).toHaveLength(0);
      expect(await t.trx('door_access_events').where({ room_id: stayRoomId })).toHaveLength(1);
      expect(await t.trx('door_access_stay_confirmations').where({ reservation_id: reservationId })).toHaveLength(1);
    });

    it('a null retention_days (not yet configured) purges nothing', async () => {
      await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: null });

      const roomId = await createRoom('RET3');
      await commit(
        csv([['RET3', 'MASTER-RET2', 'Master', '2020-01-01 10:00:00']], 'Door,Card,Type,Time'),
        { ...BASE_MAPPING, cardTypeColumn: 'Type', guestCardTypeValues: ['Guest'] }
      );

      const result = await purgeExpiredEvents({ context: workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id }) });
      expect(result.deleted).toBe(0);
      expect(await t.trx('door_access_events').where({ room_id: roomId })).toHaveLength(1);
    });

    it('an event newer than the retention window is left alone', async () => {
      await t.request.put('/api/v1/door-access/config').set('Authorization', `Bearer ${manager()}`).send({ retention_days: 30 });

      const roomId = await createRoom('RET4');
      const recent = new Date();
      recent.setUTCDate(recent.getUTCDate() - 1);
      const stamp = recent.toISOString().slice(0, 19).replace('T', ' ');
      await commit(
        csv([['RET4', 'MASTER-RET3', 'Master', stamp]], 'Door,Card,Type,Time'),
        { ...BASE_MAPPING, cardTypeColumn: 'Type', guestCardTypeValues: ['Guest'] }
      );

      // Only the recent room's own row is asserted here — a prior test's
      // leftover old event (RET3, left un-purged while retention_days was
      // null at the time) is also legitimately swept up by this call, and
      // is not this test's concern (see the previous test's own comment).
      await purgeExpiredEvents({ context: workerContext({ tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id }) });
      expect(await t.trx('door_access_events').where({ room_id: roomId })).toHaveLength(1);
    });
  });
});
