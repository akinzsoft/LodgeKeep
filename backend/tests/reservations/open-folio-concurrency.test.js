'use strict';

/**
 * H-2 (security audit, 2026-11): concurrent `openBookingFolio` calls created duplicate folios and duplicate
 * room-charge lines. Real pooled connections (the shared-transaction harness cannot prove a lock). Each call uses its
 * own Idempotency-Key, which is exactly why the idempotency layer alone never prevented it.
 */

const dbModule = require('../../src/db');
const { db } = require('../helpers/db');
const { scopedDb } = require('../../src/db');
const { withIdempotency } = require('../../src/shared/idempotency');
const reservationsService = require('../../src/modules/reservations/service');
const { seedRaceTenant, ledgerBalance, storedBalance } = require('../helpers/folio-race');

describe('opening a booking folio under real concurrent connections (H-2)', () => {
  let t;
  let seq = 0;
  const key = () => `of-key-${Date.now().toString(36)}-${(seq += 1)}`;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    t = await seedRaceTenant({ label: 'ofolio' });
  });
  afterAll(async () => {
    await t.cleanup();
    dbModule.__resetForTesting();
  });

  /** A confirmed, 2-night reservation with its daily-rate snapshot (the state `open-folio` acts on). */
  async function confirmedReservation() {
    seq += 1;
    const roomType = await db()('room_types').where({ tenant_id: t.tenantId }).first();
    const rateCode = await db()('rate_codes').where({ tenant_id: t.tenantId }).first();
    const [id] = await db()('reservations').insert({
      tenant_id: t.tenantId,
      property_id: t.propertyId,
      guest_id: t.guestId,
      room_type_id: roomType.id,
      rate_code_id: rateCode.id,
      arrival_date: '2027-06-01',
      departure_date: '2027-06-03',
      adults: 1,
      children: 0,
      status: 'confirmed',
      confirmation_number: `OF${Date.now().toString(36)}${seq}`.toUpperCase().slice(0, 26),
    });
    for (const stayDate of ['2027-06-01', '2027-06-02']) {
      await db()('reservation_daily_rates').insert({ tenant_id: t.tenantId, property_id: t.propertyId, reservation_id: id, stay_date: stayDate, rate: '100.00', currency: 'NGN' });
    }
    return id;
  }

  const openFolio = (reservationId, k = key()) =>
    withIdempotency({
      context: t.context,
      operationType: 'open_folio',
      key: k,
      payload: { id: String(reservationId) },
      isolationLevel: reservationsService.FOLIO_CREATING_ISOLATION,
      handler: async (trx) => {
        const folio = await reservationsService.openBookingFolio({ trx, id: reservationId });
        return { status: 200, body: { folioId: String(folio.id), balance: folio.balance } };
      },
    });

  const checkIn = (reservationId) =>
    withIdempotency({
      context: t.context,
      operationType: 'check_in',
      key: key(),
      payload: { id: String(reservationId) },
      isolationLevel: reservationsService.FOLIO_CREATING_ISOLATION,
      handler: async (trx) => {
        await reservationsService.checkIn({ trx, id: reservationId, roomId: t.roomId, overrideDirty: true });
        return { status: 200, body: { ok: true } };
      },
    });

  async function assertOneFolioTwoNights(reservationId) {
    const folios = await db()('folios').where({ reservation_id: reservationId });
    expect(folios).toHaveLength(1);
    const lines = await db()('folio_line_items').where({ folio_id: folios[0].id, type: 'room_charge' }).whereNull('voided_at');
    expect(lines.map((l) => String(l.business_date).slice(0, 10)).sort()).toEqual(['2027-06-01', '2027-06-02']);
    expect(await storedBalance(folios[0].id)).toBe(await ledgerBalance(folios[0].id));
    return folios[0];
  }

  it('two simultaneous opens with different keys: one folio, each night charged once', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await confirmedReservation();
      const results = await Promise.all([openFolio(id), openFolio(id)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results[0].body.folioId).toBe(results[1].body.folioId);
      await assertOneFolioTwoNights(id);
    }
  });

  it('five simultaneous opens: still exactly one folio and one charge per night', async () => {
    const id = await confirmedReservation();
    await Promise.all([1, 2, 3, 4, 5].map(() => openFolio(id)));
    await assertOneFolioTwoNights(id);
  });

  it('an open racing check-in never leaves two folios or a doubled night', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await confirmedReservation();
      const [opened, checkedIn] = await Promise.allSettled([openFolio(id), checkIn(id)]);
      // Check-in always succeeds. Open-folio succeeds if it went first; if check-in won, the reservation is no
      // longer `confirmed` and the open is refused (both orders are correct).
      expect(checkedIn.status).toBe('fulfilled');
      if (opened.status === 'rejected') expect(opened.reason.code).toBe('VALIDATION_RESERVATION_NOT_CONFIRMED');

      const folios = await db()('folios').where({ reservation_id: id });
      expect(folios).toHaveLength(1);
      const lines = await db()('folio_line_items').where({ folio_id: folios[0].id, type: 'room_charge' }).whereNull('voided_at');
      expect(lines).toHaveLength(opened.status === 'fulfilled' ? 2 : 0);
      expect(await storedBalance(folios[0].id)).toBe(await ledgerBalance(folios[0].id));

      await db()('reservation_rooms').where({ reservation_id: id }).delete();
      await db()('rooms').where({ id: t.roomId }).update({ front_desk_status: 'vacant' });
    }
  });

  it('a single call still works, and a same-key retry replays without posting again', async () => {
    const id = await confirmedReservation();
    const k = key();
    const first = await openFolio(id, k);
    expect(first.replayed).toBe(false);
    expect(first.body.balance).toBe('200.00');
    const retry = await openFolio(id, k);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    await assertOneFolioTwoNights(id);
    // A later call under a new key is a no-op on both the folio and the lines.
    await openFolio(id);
    await assertOneFolioTwoNights(id);
  });
});

describe('route wiring (H-2)', () => {
  it('open-folio and check-in both run at the folio-creating isolation level', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/reservations/controller.js'), 'utf8');
    const uses = source.match(/isolationLevel: service\.FOLIO_CREATING_ISOLATION/g) || [];
    expect(uses).toHaveLength(2);
    expect(reservationsService.FOLIO_CREATING_ISOLATION).toBe('read committed');
  });
});
