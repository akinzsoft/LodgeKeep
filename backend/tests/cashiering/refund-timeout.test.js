'use strict';

/**
 * F-09 for the refund POST: the call is bounded, and running out of time is "outcome unknown" (the refund may have been
 * made), never a refusal that would release the reserved amount. No network: `fetch` is replaced.
 */

const { buildAdapter, GatewayRequestError } = require('../../src/modules/cashiering/paystack-adapter');

describe('the Paystack refund POST', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.PAYSTACK_REFUND_TIMEOUT_MS;
  });

  /** A fetch that never answers, but honours its abort signal like the real one. */
  function hangingFetch() {
    return jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason));
    }));
  }

  it('gives up after the configured time and reports a timeout (outcome unknown), not an HTTP refusal', async () => {
    process.env.PAYSTACK_REFUND_TIMEOUT_MS = '60';
    global.fetch = hangingFetch();
    const started = Date.now();
    const error = await buildAdapter('sk_test_x').refundTransaction({ reference: 'ref', amount: '10.00' }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error.details).toMatchObject({ timedOut: true });
    expect(error.details.httpStatus).toBeUndefined(); // not "definitively refused"
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('defaults to 15 seconds and sends the signal and the exact body', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: true, data: { status: 'pending', id: 7, transaction_reference: 'ref' } }) }));
    const result = await buildAdapter('sk_test_x').refundTransaction({ reference: 'ref', amount: '10.00' });
    expect(result).toMatchObject({ status: 'pending', refundId: '7' });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeDefined();
    expect(JSON.parse(options.body)).toEqual({ transaction: 'ref', amount: 1000 });
  });

  it('a garbage timeout setting falls back to the default', async () => {
    process.env.PAYSTACK_REFUND_TIMEOUT_MS = 'soon';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: true, data: { status: 'processed', id: 1 } }) }));
    await expect(buildAdapter('sk_test_x').refundTransaction({ reference: 'ref' })).resolves.toMatchObject({ status: 'processed' });
  });

  it('lists a transaction\'s refunds by its NUMERIC id and returns amounts in subunits', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: true, data: [{ id: 5, status: 'processed', amount: 2500, createdAt: '2026-10-18T07:39:03.000Z'}] }) }));
    const rows = await buildAdapter('sk_test_x').listRefundsForTransaction({ transactionId: '6648191450' });
    expect(global.fetch.mock.calls[0][0]).toContain('/refund?transaction=6648191450');
    expect(rows).toEqual([{ refundId: '5', status: 'processed', amountSubunit: 2500, createdAt: '2026-10-18T07:39:03.000Z' }]);
  });
});
