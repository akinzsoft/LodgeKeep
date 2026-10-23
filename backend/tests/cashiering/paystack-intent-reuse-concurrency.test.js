'use strict';

/**
 * Two presses of Card at the same moment, on real pooled connections (the shared-transaction harness cannot prove a
 * lock): the folio row lock inside the intent step makes the second press see the first one's row, so one payment.
 */

const dbModule = require('../../src/db');
const { db } = require('../helpers/db');
const { scopedDb } = require('../../src/db');
const service = require('../../src/modules/cashiering/service');
const { seedRaceTenant } = require('../helpers/folio-race');

describe('Paystack folio intent: simultaneous presses', () => {
  let t;
  let n = 0;
  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    t = await seedRaceTenant({ label: 'reuse' });
  });
  afterAll(async () => {
    await t.cleanup();
    dbModule.__resetForTesting();
  });

  it.each([1, 2, 3])('round %p: two parallel presses create exactly one payment', async () => {
    const { folioId } = await t.addReservationWithFolio();
    const press = () =>
      scopedDb()
        .for(t.context)
        .transaction((trx) => service.initiatePaystackPaymentIntent({ trx, folioId, amount: '250.00', currency: 'NGN', idempotencyKey: `reuse-${Date.now().toString(36)}-${(n += 1)}`, reuseOpen: true }));
    const [a, b] = await Promise.all([press(), press()]);
    expect(String(a.id)).toBe(String(b.id));
    const rows = await db()('payments').where({ folio_id: folioId });
    expect(rows).toHaveLength(1);
  });

  it('without reuseOpen (the portal path) every call still creates its own row', async () => {
    const { folioId } = await t.addReservationWithFolio();
    const go = () =>
      scopedDb()
        .for(t.context)
        .transaction((trx) => service.initiatePaystackPaymentIntent({ trx, folioId, amount: '250.00', currency: 'NGN', idempotencyKey: `plain-${Date.now().toString(36)}-${(n += 1)}` }));
    await go();
    await go();
    expect(await db()('payments').where({ folio_id: folioId })).toHaveLength(2);
  });
});
