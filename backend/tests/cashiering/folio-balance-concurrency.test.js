'use strict';

/**
 * F-05 (product audit): `folios.balance` lost update. Real pooled connections.
 *
 * The deterministic cases hold request A open AFTER its first read (as `withIdempotency`'s key lookup does, which fixes
 * the REPEATABLE READ snapshot), run request B to completion, then let A continue. A plain SUM in A cannot see B's
 * committed line, so A overwrites `folios.balance` with a total that is missing it.
 */

const dbModule = require('../../src/db');
const { db } = require('../helpers/db');
const { scopedDb } = require('../../src/db');
const { withIdempotency } = require('../../src/shared/idempotency');
const service = require('../../src/modules/cashiering/service');
const arService = require('../../src/modules/ar/service');
const reservationsService = require('../../src/modules/reservations/service');
const { seedRaceTenant, ledgerBalance, storedBalance, gate } = require('../helpers/folio-race');

describe('folio balance under real concurrent connections (F-05)', () => {
  let t;
  let keyCounter = 0;
  const key = () => `fb-key-${Date.now().toString(36)}-${(keyCounter += 1)}`;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    t = await seedRaceTenant({ label: 'fbal' });
  });
  afterAll(async () => {
    await t.cleanup();
    dbModule.__resetForTesting();
  });

  const inTx = (fn) => scopedDb().for(t.context).transaction(fn);
  const charge = (folioId, amount) => inTx((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'c', amount, userId: null }));
  const cash = (folioId, amount) => inTx((trx) => service.captureCashPayment({ trx, folioId, amount, currency: 'NGN', idempotencyKey: key(), userId: null }));

  /** Run `a` after `b` has fully committed, with a's transaction (and snapshot) already open. */
  async function aOpenedBeforeBCommits(a, b) {
    const reached = gate();
    const release = gate();
    const aDone = withIdempotency({
      context: t.context,
      operationType: 'test.race',
      key: key(),
      payload: {},
      handler: async (trx) => {
        reached.open();
        await release.promise;
        const value = await a(trx);
        return { status: 200, body: { data: value } };
      },
    });
    await reached.promise;
    await b();
    release.open();
    return aDone;
  }

  async function expectConsistent(folioId) {
    expect(await storedBalance(folioId)).toBe(await ledgerBalance(folioId));
  }

  it('a charge and a charge: the stored balance equals the ledger', async () => {
    const { folioId } = await t.addReservationWithFolio();
    await aOpenedBeforeBCommits((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'a', amount: '10.00', userId: null }), () => charge(folioId, '5.00'));
    await expectConsistent(folioId);
    expect(await ledgerBalance(folioId)).toBe('15.00');
  });

  it('a charge racing a cash payment: the stored balance equals the ledger', async () => {
    const { folioId } = await t.addReservationWithFolio();
    await aOpenedBeforeBCommits((trx) => service.postCharge({ trx, folioId, type: 'pos_charge', description: 'a', amount: '40.00', userId: null }), () => cash(folioId, '15.00'));
    await expectConsistent(folioId);
    expect(await ledgerBalance(folioId)).toBe('25.00');
  });

  it('two payments: the stored balance equals the ledger', async () => {
    const { folioId } = await t.addReservationWithFolio();
    await charge(folioId, '100.00');
    await aOpenedBeforeBCommits((trx) => service.captureCashPayment({ trx, folioId, amount: '30.00', currency: 'NGN', idempotencyKey: key(), userId: null }), () => cash(folioId, '20.00'));
    await expectConsistent(folioId);
    expect(await ledgerBalance(folioId)).toBe('50.00');
  });

  it('a void racing a charge: the stored balance equals the ledger', async () => {
    const { folioId } = await t.addReservationWithFolio();
    const { chargeLine } = await charge(folioId, '60.00');
    await aOpenedBeforeBCommits((trx) => service.voidLineItem({ trx, lineItemId: chargeLine.id, reason: 'test', userId: null }), () => charge(folioId, '7.00'));
    await expectConsistent(folioId);
    expect(await ledgerBalance(folioId)).toBe('7.00');
  });

  it('a line move racing a charge on the destination: both stored balances equal their ledgers', async () => {
    const { reservationId, folioId: source } = await t.addReservationWithFolio();
    const destination = await t.addFolio({ reservationId });
    const { chargeLine } = await charge(source, '30.00');
    await aOpenedBeforeBCommits((trx) => service.moveLineItem({ trx, lineItemId: chargeLine.id, destinationFolioId: destination }), () => charge(destination, '4.00'));
    await expectConsistent(source);
    await expectConsistent(destination);
    expect(await ledgerBalance(destination)).toBe('34.00');
  });

  it('natural parallel charges and payments (no gate), many rounds: the stored balance always equals the ledger', async () => {
    const { folioId } = await t.addReservationWithFolio();
    await charge(folioId, '1000.00');
    for (let round = 0; round < 6; round += 1) {
      await Promise.all([charge(folioId, '3.00'), cash(folioId, '2.00'), charge(folioId, '1.00'), cash(folioId, '4.00'), charge(folioId, '5.00')]);
      await expectConsistent(folioId);
    }
  });

  it('lock order: crossing line moves, charges and refunds across two folios never deadlock', async () => {
    const { reservationId, folioId: one } = await t.addReservationWithFolio();
    const two = await t.addFolio({ reservationId });
    const lineOne = (await charge(one, '10.00')).chargeLine;
    const lineTwo = (await charge(two, '10.00')).chargeLine;
    const retries = [];
    const where = async (lineId) => String((await db()('folio_line_items').where({ id: lineId }).first()).folio_id);
    for (let round = 0; round < 30; round += 1) {
      // Each round swaps the two lines: one move names (one, two), the other (two, one) — opposite lock orders.
      const toOther = async (lineId) => ((await where(lineId)) === String(one) ? two : one);
      const [destOne, destTwo] = [await toOther(lineOne.id), await toOther(lineTwo.id)];
      const results = await Promise.allSettled([
        inTx((trx) => service.moveLineItem({ trx, lineItemId: lineOne.id, destinationFolioId: destOne })),
        inTx((trx) => service.moveLineItem({ trx, lineItemId: lineTwo.id, destinationFolioId: destTwo })),
        charge(one, '1.00'),
        charge(two, '1.00'),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') retries.push(result.reason?.code ?? result.reason?.message);
      }
    }
    expect(retries.filter((c) => /DEADLOCK/i.test(String(c)))).toEqual([]);
    await expectConsistent(one);
    await expectConsistent(two);
  });

  it('check-out cannot close a folio over a charge that committed after it started', async () => {
    const { reservationId, folioId } = await t.addReservationWithFolio({ status: 'checked_in' });
    let outcome;
    try {
      await aOpenedBeforeBCommits((trx) => reservationsService.checkOut({ trx, id: reservationId, userId: null }), () => charge(folioId, '25.00'));
      outcome = 'checked_out';
    } catch (error) {
      outcome = error.code ?? error.message;
    }
    // Either the charge is seen (check-out refused: balance owing) or check-out won and the charge was refused by a closed folio.
    const folio = await db()('folios').where({ id: folioId }).first();
    expect(folio.status === 'closed' ? folio.balance : outcome).toBeTruthy();
    expect(folio.status === 'closed' && (await ledgerBalance(folioId)) !== '0.00' ? 'closed-with-unpaid-balance' : 'ok').toBe('ok');
    await expectConsistent(folioId);
  });

  it('lock order with Accounts Receivable: charges on an AR-billed folio racing invoice runs and AR payments never deadlock', async () => {
    const { companyId, accountId } = await t.addArAccount();
    const { folioId } = await t.addReservationWithFolio();
    await inTx((trx) => service.billFolioToCompany({ trx, folioId, companyProfileId: companyId }));
    const codes = [];
    for (let round = 0; round < 5; round += 1) {
      await charge(folioId, '20.00');
      const results = await Promise.allSettled([
        charge(folioId, '3.00'),
        inTx((trx) => arService.generateInvoice({ trx, arAccountId: accountId, userId: null })),
        inTx((trx) => arService.recordPayment({ trx, arAccountId: accountId, amount: '5.00', currency: 'NGN', methodLabel: 'wire', userId: null })),
        charge(folioId, '4.00'),
        inTx((trx) => service.postAdjustment({ trx, folioId, description: 'adj', amount: '-1.00', reason: 'test', userId: null })),
      ]);
      for (const r of results) if (r.status === 'rejected') codes.push(String(r.reason?.code ?? r.reason?.message));
    }
    expect(codes.filter((c) => /DEADLOCK/i.test(c))).toEqual([]);
    await expectConsistent(folioId);
  });

  it('two voids of the same line: the second sees the first and is refused, the balance is exact', async () => {
    const { folioId } = await t.addReservationWithFolio();
    const { chargeLine } = await charge(folioId, '60.00');
    let second;
    await aOpenedBeforeBCommits(
      async (trx) => {
        second = await service.voidLineItem({ trx, lineItemId: chargeLine.id, reason: 'second', userId: null }).catch((error) => error);
      },
      () => inTx((trx) => service.voidLineItem({ trx, lineItemId: chargeLine.id, reason: 'first', userId: null }))
    );
    expect(second.code).toBe('CONFLICT_LINE_ITEM_ALREADY_VOIDED');
    const line = await db()('folio_line_items').where({ id: chargeLine.id }).first();
    expect(line.void_reason).toBe('first');
    await expectConsistent(folioId);
  });
});
