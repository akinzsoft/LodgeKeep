'use strict';

/**
 * HTTP-level tests for the cashiering module — PLAN.md Phase 2.5 step 1
 * ("the real folio ledger") and step 2 ("Payment integration"). Covers
 * charge posting with tax, adjustments, void-with-reason (and its tax-line
 * cascade), split billing, cash payment capture and refund (fully real,
 * synchronous), the Paystack state-machine transitions applied via a
 * mocked adapter (deterministic, no live network — see
 * `tests/cashiering/paystack-adapter.test.js` for the real-sandbox
 * coverage), RBAC gating across the two cashiering permission keys, and
 * idempotency replay.
 *
 * ── AMBIENT TAX ──────────────────────────────────────────────────────────
 *
 * `tests/helpers/fixtures.js` already seeds a real 7.5% `VAT` tax
 * (`applies_to: 'all'`, effective from 2026-01-01) on `ctx.a`/`ctx.b`'s own
 * property — Phase 1's own fixture, not this file's. Every `room_charge`
 * posted anywhere in this file picks it up automatically. Tests that only
 * care about payment/void/split-billing MECHANICS (not tax arithmetic)
 * seed their starting balance via `seedAdjustment` (a direct, tax-free
 * `folio_line_items` insert) rather than `POST .../charges`, so their
 * expected numbers don't depend on what tax happens to be configured. The
 * dedicated "tax" describe block is the only place this file adds MORE tax
 * rows, and it runs LAST — nothing after it would be affected by the
 * property now carrying extra tax versions.
 *
 * Cross-tenant isolation for every table here already comes free from
 * tests/isolation's ISO-* suite via tests/helpers/entities.js.
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

describe('Cashiering (PLAN.md Phase 2.5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-01-10' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
    return `cashiering-test-key-${idemCounter}`;
  }

  let folioCounter = 0;
  async function openFolio(tenant = ctx.a, { reservationId, billedTo = 'Guest' } = {}) {
    folioCounter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: reservationId ?? tenant.reservations[0].id,
      folio_number: `TF${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: billedTo,
    });
    return t.trx('folios').where({ id }).first();
  }

  /** A tax-free starting balance, for tests exercising payment/void/split mechanics rather than tax arithmetic — see file header. */
  async function seedAdjustment(folio, amount) {
    const [id] = await t.trx('folio_line_items').insert({
      tenant_id: folio.tenant_id,
      property_id: folio.property_id,
      folio_id: folio.id,
      type: 'adjustment',
      description: 'Test fixture balance',
      amount,
      currency: folio.currency,
      business_date: '2027-01-10',
    });
    await t.trx('folios').where({ id: folio.id }).update({ balance: amount });
    return t.trx('folio_line_items').where({ id }).first();
  }

  // ====================================================================
  // Void — ARCHITECTURE.md §8
  // ====================================================================

  describe('void', () => {
    it('voids a charge line and cascades the void to its own tax line, recomputing the balance', async () => {
      const folio = await openFolio();
      const chargeRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room', amount: '100.00' });
      const chargeLineId = chargeRes.body.data.id;
      const balanceBeforeVoid = (await t.trx('folios').where({ id: folio.id }).first()).balance;
      expect(balanceBeforeVoid).not.toBe('0.00'); // The ambient fixture VAT applied — see file header.

      const res = await t.request
        .post(`/api/v1/cashiering/line-items/${chargeLineId}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Posted in error' });
      expect(res.status).toBe(200);

      const lines = await t.trx('folio_line_items').where({ folio_id: folio.id });
      expect(lines.every((l) => l.voided_at !== null)).toBe(true);

      const updated = await t.trx('folios').where({ id: folio.id }).first();
      expect(updated.balance).toBe('0.00');
    });

    it('refuses to void an already-voided line', async () => {
      const folio = await openFolio();
      const line = await seedAdjustment(folio, '30.00');

      await t.request
        .post(`/api/v1/cashiering/line-items/${line.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'First void' });

      const res = await t.request
        .post(`/api/v1/cashiering/line-items/${line.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Second attempt' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_LINE_ITEM_ALREADY_VOIDED');
    });

    it('refuses to void a payment line directly', async () => {
      const folio = await openFolio();
      const paymentRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '10.00', currency: 'NGN' });
      const paymentLine = await t.trx('folio_line_items').where({ payment_id: paymentRes.body.data.id }).first();

      const res = await t.request
        .post(`/api/v1/cashiering/line-items/${paymentLine.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Should not work' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_CANNOT_VOID_PAYMENT_LINE');
    });
  });

  // ====================================================================
  // Adjustments & folio lifecycle
  // ====================================================================

  describe('adjustments and folio state', () => {
    it('an adjustment requires a reason and applies its signed amount directly, with no tax', async () => {
      const folio = await openFolio();
      const missingReason = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/adjustments`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ description: 'Comp', amount: '-20.00' });
      expect(missingReason.status).toBe(400);

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/adjustments`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ description: 'Goodwill discount', amount: '-20.00', reason: 'Guest complaint' });
      expect(res.status).toBe(201);
      expect(res.body.data.amount).toBe('-20.00');

      const updated = await t.trx('folios').where({ id: folio.id }).first();
      expect(updated.balance).toBe('-20.00');
    });

    it('refuses a charge against a closed folio', async () => {
      const folio = await openFolio();
      await t.trx('folios').where({ id: folio.id }).update({ status: 'closed' });

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room 101', amount: '50.00' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_FOLIO_ALREADY_CLOSED');
    });
  });

  // ====================================================================
  // Split billing — PRODUCT_REQUIREMENTS.md §3.5
  // ====================================================================

  describe('split billing', () => {
    it('opens an additional folio and moves a line item onto it, recomputing both balances', async () => {
      const primary = await openFolio();
      const line = await seedAdjustment(primary, '15.00');

      const openRes = await t.request
        .post(`/api/v1/cashiering/reservations/${ctx.a.reservations[0].id}/folios`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ billed_to: 'Company ABC' });
      expect(openRes.status).toBe(201);
      expect(openRes.body.data.billed_to).toBe('Company ABC');
      const secondFolioId = openRes.body.data.id;

      const moveRes = await t.request
        .post(`/api/v1/cashiering/line-items/${line.id}/move`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ destination_folio_id: String(secondFolioId) });
      expect(moveRes.status).toBe(200);

      const primaryAfter = await t.trx('folios').where({ id: primary.id }).first();
      const secondAfter = await t.trx('folios').where({ id: secondFolioId }).first();
      expect(primaryAfter.balance).toBe('0.00');
      expect(secondAfter.balance).toBe('15.00');
    });

    it("a charge's own tax line moves along with it", async () => {
      const primary = await openFolio();
      const chargeRes = await t.request
        .post(`/api/v1/cashiering/folios/${primary.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room', amount: '100.00' });
      const chargeLineId = chargeRes.body.data.id;
      const primaryBalanceBefore = (await t.trx('folios').where({ id: primary.id }).first()).balance;

      const openRes = await t.request
        .post(`/api/v1/cashiering/reservations/${ctx.a.reservations[0].id}/folios`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      const secondFolioId = openRes.body.data.id;

      await t.request
        .post(`/api/v1/cashiering/line-items/${chargeLineId}/move`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ destination_folio_id: String(secondFolioId) });

      const primaryAfter = await t.trx('folios').where({ id: primary.id }).first();
      const secondAfter = await t.trx('folios').where({ id: secondFolioId }).first();
      expect(primaryAfter.balance).toBe('0.00');
      expect(secondAfter.balance).toBe(primaryBalanceBefore);

      const secondFolioLines = await t.trx('folio_line_items').where({ folio_id: secondFolioId });
      expect(secondFolioLines.map((l) => l.type).sort()).toEqual(['room_charge', 'tax']);
    });

    it('refuses to move a line item to a folio on a different reservation within the same tenant', async () => {
      const [otherReservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: ctx.a.guests[0].id,
        room_type_id: ctx.a.roomTypes[0].id,
        rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: '2027-03-01',
        departure_date: '2027-03-02',
        adults: 1,
        children: 0,
        status: 'confirmed',
        confirmation_number: 'SPLITOTHER01',
      });
      const otherFolio = await openFolio(ctx.a, { reservationId: otherReservationId });

      const primary = await openFolio();
      const line = await seedAdjustment(primary, '10.00');

      const res = await t.request
        .post(`/api/v1/cashiering/line-items/${line.id}/move`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ destination_folio_id: String(otherFolio.id) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_CROSS_RESERVATION_FOLIO_MOVE');
    });
  });

  // ====================================================================
  // Cash payments & refunds — real, synchronous, no gateway
  // ====================================================================

  describe('cash payments', () => {
    it('captures a cash payment, zeroing the balance, and replays the identical response on a retried idempotency key', async () => {
      const folio = await openFolio();
      await seedAdjustment(folio, '80.00');

      const key = idemKey();
      const first = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({ amount: '80.00', currency: 'NGN' });
      expect(first.status).toBe(201);
      expect(first.body.data.status).toBe('CAPTURED');

      const afterFirst = await t.trx('folios').where({ id: folio.id }).first();
      expect(afterFirst.balance).toBe('0.00');

      const replay = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', key)
        .send({ amount: '80.00', currency: 'NGN' });
      expect(replay.body.data.id).toBe(first.body.data.id);

      const paymentCount = await t.trx('payments').where({ folio_id: folio.id }).count({ n: '*' }).first();
      expect(Number(paymentCount.n)).toBe(1);
    });

    it('refunds a cash payment in full and reopens the balance', async () => {
      const folio = await openFolio();
      await seedAdjustment(folio, '40.00');
      const paymentRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '40.00', currency: 'NGN' });

      const refundRes = await t.request
        .post(`/api/v1/cashiering/payments/${paymentRes.body.data.id}/refund`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Guest requested a refund' });
      expect(refundRes.status).toBe(201);
      expect(refundRes.body.data.status).toBe('CAPTURED');

      const originalPayment = await t.trx('payments').where({ id: paymentRes.body.data.id }).first();
      expect(originalPayment.status).toBe('REFUNDED');

      const updatedFolio = await t.trx('folios').where({ id: folio.id }).first();
      expect(updatedFolio.balance).toBe('40.00');
    });

    it('refuses a refund exceeding the amount available', async () => {
      const folio = await openFolio();
      await seedAdjustment(folio, '40.00');
      const paymentRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '40.00', currency: 'NGN' });

      const res = await t.request
        .post(`/api/v1/cashiering/payments/${paymentRes.body.data.id}/refund`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '100.00', reason: 'Too much' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_REFUND_EXCEEDS_CAPTURED_AMOUNT');
    });
  });

  // ====================================================================
  // Paystack — real state machine, mocked adapter (no live network here;
  // see tests/cashiering/paystack-adapter.test.js for real-sandbox coverage)
  // ====================================================================

  describe('paystack payments', () => {
    it('initiates a payment intent, starts checkout, and returns an authorization_url', async () => {
      paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({
        authorizationUrl: 'https://paystack.test/pay/abc',
        accessCode: 'abc',
        reference,
      }));

      const folio = await openFolio();
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/paystack`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '60.00', currency: 'NGN', guest_email: 'guest@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.meta.authorizationUrl).toBe('https://paystack.test/pay/abc');
      expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
    });

    it('a verify call after a successful gateway status applies CAPTURED and posts the folio effect', async () => {
      paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/xyz', accessCode: 'xyz', reference }));

      const folio = await openFolio();
      await seedAdjustment(folio, '60.00');

      const initRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/paystack`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '60.00', currency: 'NGN', guest_email: 'guest@example.com' });
      const paymentId = initRes.body.data.id;
      const storedPayment = await t.trx('payments').where({ id: paymentId }).first();

      paystack.verifyTransaction.mockResolvedValue({
        status: 'success',
        reference: storedPayment.provider_reference,
        providerPaymentId: '999',
        amountSubunit: 6000,
        currency: 'NGN',
      });

      const verifyRes = await t.request
        .post(`/api/v1/cashiering/payments/${paymentId}/verify`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.status).toBe('CAPTURED');

      const updatedFolio = await t.trx('folios').where({ id: folio.id }).first();
      expect(updatedFolio.balance).toBe('0.00');
    });

    it('a verified webhook applies the same CAPTURED transition idempotently, deduplicated by provider_event_id', async () => {
      paystack.initializeTransaction.mockImplementation(async ({ reference }) => ({ authorizationUrl: 'https://paystack.test/pay/w1', accessCode: 'w1', reference }));
      paystack.verifyWebhookSignature.mockReturnValue(true);

      const folio = await openFolio();
      const initRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/paystack`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '20.00', currency: 'NGN', guest_email: 'guest@example.com' });
      const storedPayment = await t.trx('payments').where({ id: initRes.body.data.id }).first();

      const webhookBody = { event: 'charge.success', data: { id: 555, reference: storedPayment.provider_reference, status: 'success' } };
      const first = await t.request
        .post('/api/v1/webhooks/paystack')
        .set('x-paystack-signature', 'irrelevant-mocked')
        .send(webhookBody);
      expect(first.status).toBe(200);

      const payment = await t.trx('payments').where({ id: initRes.body.data.id }).first();
      expect(payment.status).toBe('CAPTURED');

      // A retried webhook (same provider_event_id) is deduplicated — no second folio effect.
      const second = await t.request
        .post('/api/v1/webhooks/paystack')
        .set('x-paystack-signature', 'irrelevant-mocked')
        .send(webhookBody);
      expect(second.status).toBe(200);

      const paymentLines = await t.trx('folio_line_items').where({ payment_id: initRes.body.data.id });
      expect(paymentLines).toHaveLength(1);
    });

    it('an unverified webhook is persisted but never applied', async () => {
      paystack.verifyWebhookSignature.mockReturnValue(false);

      const webhookBody = { event: 'charge.success', data: { id: 777, reference: 'ref-does-not-exist', status: 'success' } };
      const res = await t.request.post('/api/v1/webhooks/paystack').set('x-paystack-signature', 'bad-signature').send(webhookBody);
      expect(res.status).toBe(200);

      const eventRow = await t.trx('payment_webhook_events').where({ provider_event_id: '777' }).first();
      expect(eventRow.verified).toBe(0);
      expect(eventRow.processed_at).toBeNull();
    });
  });

  // ====================================================================
  // RBAC — SECURITY.md §5's Cashiering row
  // ====================================================================

  describe('RBAC', () => {
    it('front_desk can post a charge but not capture a payment — SECURITY.md §5 "Limited"', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'front_desk' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const folio = await openFolio();

      const chargeRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room', amount: '10.00' });
      expect(chargeRes.status).toBe(201);

      const paymentRes = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '10.00', currency: 'NGN' });
      expect(paymentRes.status).toBe(403);
    });

    it('housekeeping has no cashiering access at all', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'housekeeping' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const folio = await openFolio();

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room', amount: '10.00' });
      expect(res.status).toBe(403);
    });

    it('a mutation with no Idempotency-Key header is rejected', async () => {
      const folio = await openFolio();
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ type: 'room_charge', description: 'Room', amount: '10.00' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_IDEMPOTENCY_KEY');
    });
  });

  // ====================================================================
  // Tax — ARCHITECTURE.md §12.1. Runs LAST: this block adds MORE tax rows
  // to the property, and nothing after it should have its own expected
  // numbers depend on that (see file header).
  // ====================================================================

  describe('tax', () => {
    it("applies the property's already-configured VAT automatically and itemizes it as its own line", async () => {
      const folio = await openFolio();
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room 101', amount: '100.00' });

      expect(res.status).toBe(201);
      expect(res.body.data.amount).toBe('100.00');
      expect(res.body.meta.taxLines).toHaveLength(1);
      expect(res.body.meta.taxLines[0]).toMatchObject({ type: 'tax', amount: '7.50', description: 'VAT (VAT)' });

      const updated = await t.trx('folios').where({ id: folio.id }).first();
      expect(updated.balance).toBe('107.50');

      const lines = await t.trx('folio_line_items').where({ folio_id: folio.id }).orderBy('id');
      expect(lines.map((l) => l.type)).toEqual(['room_charge', 'tax']);
      expect(lines[1].related_line_item_id).toBe(lines[0].id);
    });

    it('stacks a second, property-specific tax on top of the ambient VAT, each itemized separately', async () => {
      await t.trx('taxes').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        tax_code: 'TOURISM_LEVY',
        name: 'Tourism levy',
        rate: '2.0000',
        applies_to: 'room_charge',
        effective_from: '2027-01-01',
        is_inclusive: false,
        calculation_method: 'percentage',
        priority: 1,
        is_compound: false,
        rounding_method: 'half_up',
      });

      const folio = await openFolio();
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Room 101', amount: '100.00' });

      expect(res.status).toBe(201);
      const taxDescriptions = res.body.meta.taxLines.map((l) => l.description).sort();
      expect(taxDescriptions).toEqual(['Tourism levy (TOURISM_LEVY)', 'VAT (VAT)']);

      const updated = await t.trx('folios').where({ id: folio.id }).first();
      expect(updated.balance).toBe('109.50'); // 100 + 7.50 (VAT) + 2.00 (levy), both non-compound against the original base.
    });
  });
});
