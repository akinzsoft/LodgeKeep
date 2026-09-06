'use strict';

/**
 * HTTP-level tests for the guest booking portal's booking+payment flow —
 * PLAN.md Phase 4's own named exit gates: "a guest session cannot satisfy
 * any PMS route," full booking→pay→confirm→email, "payment failure
 * mid-booking leaves no orphaned reservation and no orphaned charge," and
 * per-night charge posting that does not collide with Night Audit.
 *
 * Paystack is mocked exactly like `tests/cashiering/cashiering.test.js`
 * already mocks it — deterministic, no live network. Every PUBLIC portal
 * request carries no bearer token, so — like `/auth/login`/`/auth/register`
 * — it needs `X-Tenant-Slug` (the dev/test override `resolveTenant` reads
 * in place of a real Host-header subdomain) to resolve `req.tenantId` at
 * all; `publicRequest()` below is a thin wrapper so every call site gets
 * this without repeating it.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => ({
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter');

describe('Guest portal booking + payment (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;
  let propertySlug;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    const property = await t.trx('properties').where({ id: ctx.a.properties[0].id }).first('slug');
    propertySlug = property.slug;
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function publicRequest(method, path) {
    return t.request[method](path).set('X-Tenant-Slug', ctx.a.slug);
  }

  async function createRoomType(code) {
    const [id] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code,
      name: code,
      default_occupancy: 2,
      base_rate: '100.00',
    });
    return id;
  }

  async function createRoom(roomTypeId, roomNumber) {
    const [id] = await t.trx('rooms').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      room_type_id: roomTypeId,
      room_number: roomNumber,
      status: 'active',
      housekeeping_reported_status: 'clean',
    });
    return id;
  }

  async function createRateCode(code) {
    const [id] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code,
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    return id;
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `portal-test-key-${idemCounter}-${Date.now()}`;
  }

  function bookingBody({ roomTypeId, rateCodeId, arrival, departure }) {
    idemCounter += 1;
    return {
      property_slug: propertySlug,
      room_type_id: String(roomTypeId),
      rate_code_id: String(rateCodeId),
      arrival_date: arrival,
      departure_date: departure,
      first_name: 'Portal',
      last_name: 'Guest',
      email: `portal-guest-${idemCounter}@example.com`,
      phone: '+10000000002',
    };
  }

  describe('branding + availability (public)', () => {
    it('returns real property branding', async () => {
      const res = await publicRequest('get', '/api/v1/portal/properties/branding').query({ property_slug: propertySlug });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBeTruthy();
      expect(res.body.data.baseCurrency).toBeTruthy();
    });

    it('404s an unknown property slug', async () => {
      const res = await publicRequest('get', '/api/v1/portal/properties/branding').query({ property_slug: 'no-such-property' });
      expect(res.status).toBe(404);
    });

    it('checks availability without any bearer token', async () => {
      const roomTypeId = await createRoomType('PORTALAVAIL');
      await createRoom(roomTypeId, 'PA1');
      const res = await publicRequest('get', '/api/v1/portal/availability').query({
        property_slug: propertySlug,
        room_type_id: String(roomTypeId),
        arrival_date: '2027-06-01',
        departure_date: '2027-06-02',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.minSellable).toBe(1);
    });

    it('lists active room types and rate codes, both public', async () => {
      const roomTypeId = await createRoomType('PORTALLISTRT');
      await createRateCode('PORTALLISTRATE');

      const roomTypes = await publicRequest('get', '/api/v1/portal/room-types').query({ property_slug: propertySlug });
      expect(roomTypes.status).toBe(200);
      expect(roomTypes.body.data.some((rt) => String(rt.id) === String(roomTypeId))).toBe(true);

      const rateCodes = await publicRequest('get', '/api/v1/portal/rate-codes').query({ property_slug: propertySlug });
      expect(rateCodes.status).toBe(200);
      expect(rateCodes.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('anonymous booking — happy path', () => {
    it('books as a hold, posts one charge per night, and only confirms + emails after payment is captured', async () => {
      const roomTypeId = await createRoomType('PORTALHAPPY');
      await createRoom(roomTypeId, 'PH1');
      const rateCodeId = await createRateCode('PORTALHAPPYRATE');

      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/abc', accessCode: 'abc', reference: 'will-be-overridden' });

      const create = await publicRequest('post', '/api/v1/portal/bookings')
        .set('Idempotency-Key', idemKey())
        .send(bookingBody({ roomTypeId, rateCodeId, arrival: '2027-07-01', departure: '2027-07-03' }));
      expect(create.status).toBe(201);
      expect(create.body.data.reservation.status).toBe('tentative');
      expect(create.body.meta.authorizationUrl).toBe('https://paystack.test/pay/abc');

      const reservationId = create.body.data.reservation.id;
      const confirmationNumber = create.body.data.reservation.confirmation_number;

      // Per-night charges, not one aggregate — the Night Audit non-collision requirement.
      const folio = await t.trx('folios').where({ reservation_id: reservationId }).first();
      const chargeLines = await t.trx('folio_line_items').where({ folio_id: folio.id, type: 'room_charge' });
      expect(chargeLines.length).toBe(2);
      expect(chargeLines.map((l) => String(l.business_date)).sort()).toEqual(['2027-07-01', '2027-07-02']);

      // No confirmation email yet — the reservation is still just a hold.
      const pendingOutbox = await t.trx('outbox_events').where({ event_type: 'reservation.confirmed', aggregate_id: reservationId });
      expect(pendingOutbox.length).toBe(0);

      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'ref', providerPaymentId: 'ps_1', amountSubunit: 1, currency: 'NGN' });

      const confirm = await publicRequest('post', `/api/v1/portal/bookings/${confirmationNumber}/confirm`).send({ property_slug: propertySlug });
      expect(confirm.status).toBe(200);
      expect(confirm.body.data.reservation.status).toBe('confirmed');
      expect(confirm.body.data.payment.status).toBe('CAPTURED');

      const confirmedOutbox = await t.trx('outbox_events').where({ event_type: 'reservation.confirmed', aggregate_id: reservationId });
      expect(confirmedOutbox.length).toBe(1);

      const finalFolio = await t.trx('folios').where({ id: folio.id }).first();
      expect(finalFolio.balance).toBe('0.00');
    });
  });

  describe('overbooking — a failed local step is rejected cleanly', () => {
    // Same assertion shape as RES-4 (tests/reservations/reservations.test.js)
    // — status + error code only, not a row-count/orphan check. This
    // module's own `useTestApp()` harness shares ONE already-open
    // transaction across the whole file (`tests/helpers/db.js`), and
    // `scoped-db.js`'s own `transaction()` deliberately does not open a
    // real nested savepoint when the underlying connection is already a
    // transaction (see that method's own comment) — so a real rollback
    // genuinely happens in production but cannot be observed from inside
    // this shared-transaction harness, the identical limitation
    // `tests/isolation/scoped-accessor.test.js`'s own comment already
    // documents for concurrent-lock testing. Proving an actual rollback
    // needs the real-connection-pool harness `tests/reservations/
    // concurrency.test.js` established for exactly this reason.
    it('rejects a second booking past the threshold with a clear reason', async () => {
      const roomTypeId = await createRoomType('PORTALFULL');
      await createRoom(roomTypeId, 'PF1');
      const rateCodeId = await createRateCode('PORTALFULLRATE');

      await publicRequest('post', '/api/v1/portal/bookings')
        .set('Idempotency-Key', idemKey())
        .send(bookingBody({ roomTypeId, rateCodeId, arrival: '2027-08-01', departure: '2027-08-02' }));

      const overbook = await publicRequest('post', '/api/v1/portal/bookings')
        .set('Idempotency-Key', idemKey())
        .send(bookingBody({ roomTypeId, rateCodeId, arrival: '2027-08-01', departure: '2027-08-02' }));
      expect(overbook.status).toBe(422);
      expect(overbook.body.error.code).toBe('BUSINESS_RULE_OVERBOOKING_THRESHOLD_EXCEEDED');
    });
  });

  describe('payment failure — orphan prevention', () => {
    it('voids every posted charge and cancels the reservation, releasing the room', async () => {
      const roomTypeId = await createRoomType('PORTALFAIL');
      await createRoom(roomTypeId, 'PFAIL1');
      const rateCodeId = await createRateCode('PORTALFAILRATE');

      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/xyz', accessCode: 'xyz', reference: 'ref' });

      const create = await publicRequest('post', '/api/v1/portal/bookings')
        .set('Idempotency-Key', idemKey())
        .send(bookingBody({ roomTypeId, rateCodeId, arrival: '2027-09-01', departure: '2027-09-02' }));
      const reservationId = create.body.data.reservation.id;
      const confirmationNumber = create.body.data.reservation.confirmation_number;
      const folioId = create.body.data.folio.id;

      paystack.verifyTransaction.mockResolvedValue({ status: 'failed', reference: 'ref', providerPaymentId: 'ps_2', amountSubunit: 1, currency: 'NGN' });

      const confirm = await publicRequest('post', `/api/v1/portal/bookings/${confirmationNumber}/confirm`).send({ property_slug: propertySlug });
      expect(confirm.status).toBe(200);
      expect(confirm.body.data.reservation.status).toBe('cancelled');
      expect(confirm.body.data.payment.status).toBe('FAILED');

      const lines = await t.trx('folio_line_items').where({ folio_id: folioId });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.voided_at !== null)).toBe(true);

      const folio = await t.trx('folios').where({ id: folioId }).first();
      expect(folio.status).toBe('closed');

      // The room is sellable again for the same dates.
      const availability = await publicRequest('get', '/api/v1/portal/availability').query({
        property_slug: propertySlug,
        room_type_id: String(roomTypeId),
        arrival_date: '2027-09-01',
        departure_date: '2027-09-02',
      });
      expect(availability.body.data.minSellable).toBe(1);

      // Calling confirm again is a no-op, not a second cancellation attempt.
      const second = await publicRequest('post', `/api/v1/portal/bookings/${confirmationNumber}/confirm`).send({ property_slug: propertySlug });
      expect(second.status).toBe(200);
      expect(second.body.data.reservation.status).toBe('cancelled');

      const reservation = await t.trx('reservations').where({ id: reservationId }).first();
      expect(reservation.status).toBe('cancelled');
    });
  });

  describe('account-linked booking + ownership isolation', () => {
    async function registerAndGetToken(email) {
      const res = await publicRequest('post', '/api/v1/portal/auth/register').send({
        property_slug: propertySlug,
        email,
        password: 'a brand new strong passphrase',
        first_name: 'Account',
        last_name: 'Guest',
      });
      return res.body.data.accessToken;
    }

    it('books under the authenticated account, and lists/gets it back through the account endpoints', async () => {
      const token = await registerAndGetToken(`account-booker-${Date.now()}@example.com`);
      const roomTypeId = await createRoomType('PORTALACCT');
      await createRoom(roomTypeId, 'PACCT1');
      const rateCodeId = await createRateCode('PORTALACCTRATE');
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/acct', accessCode: 'a', reference: 'r' });

      const create = await t.request
        .post('/api/v1/portal/account/bookings')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({
          property_slug: propertySlug,
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-10-01',
          departure_date: '2027-10-02',
        });
      expect(create.status).toBe(201);

      const list = await t.request.get('/api/v1/portal/account/bookings').set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.data.some((r) => String(r.id) === String(create.body.data.reservation.id))).toBe(true);

      const detail = await t.request.get(`/api/v1/portal/account/bookings/${create.body.data.reservation.id}`).set('Authorization', `Bearer ${token}`);
      expect(detail.status).toBe(200);
    });

    it("404s another guest's booking, never 403", async () => {
      const tokenA = await registerAndGetToken(`isolation-a-${Date.now()}@example.com`);
      const tokenB = await registerAndGetToken(`isolation-b-${Date.now()}@example.com`);
      const roomTypeId = await createRoomType('PORTALISO');
      await createRoom(roomTypeId, 'PISO1');
      const rateCodeId = await createRateCode('PORTALISORATE');
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/iso', accessCode: 'a', reference: 'r' });

      const create = await t.request
        .post('/api/v1/portal/account/bookings')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', idemKey())
        .send({
          property_slug: propertySlug,
          room_type_id: String(roomTypeId),
          rate_code_id: String(rateCodeId),
          arrival_date: '2027-11-01',
          departure_date: '2027-11-02',
        });

      const res = await t.request
        .get(`/api/v1/portal/account/bookings/${create.body.data.reservation.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });
  });

  describe("a guest session cannot satisfy any PMS route", () => {
    it('rejects a guest token against a staff route with a real 401, not a silent scope filter', async () => {
      const token = signAccessToken({
        aud: 'guest',
        sub: String(ctx.a.guestAccounts[0].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      const res = await t.request.get('/api/v1/reservations').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });

    it('rejects a staff token against a portal account route', async () => {
      const staffToken = signAccessToken({
        aud: 'staff',
        sub: String(ctx.a.users[0].id),
        tenant_id: String(ctx.a.id),
        property_id: String(ctx.a.properties[0].id),
      });
      const res = await t.request.get('/api/v1/portal/account/bookings').set('Authorization', `Bearer ${staffToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_WRONG_AUDIENCE');
    });
  });

  describe('idempotency', () => {
    it('replays the exact same booking on a reused key, never double-processing', async () => {
      const roomTypeId = await createRoomType('PORTALIDEM');
      await createRoom(roomTypeId, 'PIDEM1');
      await createRoom(roomTypeId, 'PIDEM2');
      const rateCodeId = await createRateCode('PORTALIDEMRATE');
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/idem', accessCode: 'a', reference: 'r' });

      const key = idemKey();
      const body = bookingBody({ roomTypeId, rateCodeId, arrival: '2027-12-01', departure: '2027-12-02' });

      const first = await publicRequest('post', '/api/v1/portal/bookings').set('Idempotency-Key', key).send(body);
      const second = await publicRequest('post', '/api/v1/portal/bookings').set('Idempotency-Key', key).send(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.reservation.id).toBe(first.body.data.reservation.id);

      const reservations = await t.trx('reservations').where({ confirmation_number: first.body.data.reservation.confirmation_number });
      expect(reservations.length).toBe(1);
    });
  });
});
