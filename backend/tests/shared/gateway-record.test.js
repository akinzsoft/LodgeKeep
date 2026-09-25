'use strict';

const { classifyGatewayRecord, interpretGatewayError } = require('../../src/shared/gateway-record');

const local = { reference: 'ref-1', amount: '20.00', currency: 'NGN' };
const good = { status: 'success', reference: 'ref-1', amountSubunit: 2000, currency: 'NGN' };

function classify(recordOverrides = {}, localOverrides = {}) {
  return classifyGatewayRecord({ record: { ...good, ...recordOverrides }, local: { ...local, ...localOverrides } });
}

function codes(result) {
  return result.reasons.map((reason) => reason.code);
}

describe('classifyGatewayRecord — a successful Paystack record', () => {
  it('confirms an exact match on reference, amount and currency', () => {
    const result = classify();
    expect(result.verdict).toBe('confirmed');
    expect(result.reasons).toEqual([]);
  });

  it.each([
    ['one kobo short', { amountSubunit: 1999 }],
    ['one kobo over', { amountSubunit: 2001 }],
    ['a tiny amount', { amountSubunit: 1 }],
    ['zero', { amountSubunit: 0 }],
  ])('rejects %s as AMOUNT_MISMATCH', (_label, override) => {
    const result = classify(override);
    expect(result.verdict).toBe('mismatch');
    expect(codes(result)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('rejects a different currency, and compares currency case-insensitively', () => {
    expect(codes(classify({ currency: 'USD' }))).toEqual(['CURRENCY_MISMATCH']);
    expect(classify({ currency: 'ngn' }).verdict).toBe('confirmed');
    expect(classify({}, { currency: 'ngn' }).verdict).toBe('confirmed');
  });

  it('rejects a record naming a different reference', () => {
    const result = classify({ reference: 'someone-elses-ref' });
    expect(result.verdict).toBe('mismatch');
    expect(codes(result)).toEqual(['REFERENCE_MISMATCH']);
  });

  it('accepts a record with no reference field (nothing to contradict)', () => {
    expect(classify({ reference: undefined }).verdict).toBe('confirmed');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a float', 1999.5],
    ['a negative number', -2000],
    ['a non-numeric string', 'abc'],
  ])('fails closed when the amount is %s', (_label, amountSubunit) => {
    const result = classify({ amountSubunit });
    expect(result.verdict).toBe('mismatch');
    expect(codes(result)).toEqual(['AMOUNT_MISSING']);
  });

  it('fails closed when the currency is missing', () => {
    expect(codes(classify({ currency: undefined }))).toEqual(['CURRENCY_MISMATCH']);
  });

  it('accepts a numeric-string amount', () => {
    expect(classify({ amountSubunit: '2000' }).verdict).toBe('confirmed');
  });

  it('collects every reason at once', () => {
    const result = classify({ reference: 'other', amountSubunit: 5, currency: 'USD' });
    expect(result.verdict).toBe('mismatch');
    expect(codes(result).sort()).toEqual(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'REFERENCE_MISMATCH']);
  });

  describe('a customer-borne processing fee', () => {
    it('accepts collected > expected only when the REQUESTED amount matches', () => {
      expect(classify({ amountSubunit: 2030, requestedAmountSubunit: 2000 }).verdict).toBe('confirmed');
    });

    it('never accepts collected < expected, even if requested matches', () => {
      expect(classify({ amountSubunit: 1990, requestedAmountSubunit: 2000 }).verdict).toBe('mismatch');
    });

    it('does not accept collected > expected when requested does not match', () => {
      expect(classify({ amountSubunit: 2030, requestedAmountSubunit: 2010 }).verdict).toBe('mismatch');
      expect(classify({ amountSubunit: 2030 }).verdict).toBe('mismatch');
    });
  });

  describe('exact amounts', () => {
    it.each([
      ['0.10', 10],
      ['0.01', 1],
      ['1000000.00', 100000000],
      ['19.99', 1999],
      ['150', 15000],
    ])('%s is %i subunits', (amount, subunits) => {
      expect(classify({ amountSubunit: subunits }, { amount }).verdict).toBe('confirmed');
      expect(classify({ amountSubunit: subunits + 1 }, { amount }).verdict).toBe('mismatch');
    });
  });
});

describe('classifyGatewayRecord — non-success statuses', () => {
  it.each(['failed', 'reversed'])('reads %s as a definitive failure regardless of amount', (status) => {
    const result = classify({ status, amountSubunit: 1, currency: 'USD' });
    expect(result.verdict).toBe('failed');
  });

  it.each(['abandoned', 'ongoing', 'pending', 'processing', 'queued', 'something-new'])('reads %s as not final — neither capture nor terminal failure', (status) => {
    expect(classify({ status }).verdict).toBe('not_final');
  });

  it('is not a mismatch when a non-success record has a different amount', () => {
    expect(classify({ status: 'abandoned', amountSubunit: 0 }).verdict).toBe('not_final');
  });

  it('still flags a wrong-reference record even when its status is not success', () => {
    expect(classify({ status: 'failed', reference: 'other' }).verdict).toBe('mismatch');
    expect(classify({ status: 'abandoned', reference: 'other' }).verdict).toBe('mismatch');
  });

  it('treats a missing record as not final rather than throwing', () => {
    expect(classifyGatewayRecord({ record: undefined, local }).verdict).toBe('not_final');
  });
});

describe('interpretGatewayError', () => {
  it('reads a Paystack 404 as "no such transaction"', () => {
    expect(interpretGatewayError({ details: { httpStatus: 404 } })).toBe('record_not_found');
  });

  it.each([
    ['a 401 (bad key)', { details: { httpStatus: 401 } }],
    ['a 403', { details: { httpStatus: 403 } }],
    ['a 429', { details: { httpStatus: 429 } }],
    ['a 500', { details: { httpStatus: 500 } }],
    ['a timeout', { details: { timedOut: true } }],
    ['a network failure', { details: { network: true } }],
    ['an unconfigured gateway', { code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' }],
    ['an unexpected error', new Error('boom')],
    ['nothing at all', undefined],
  ])('reads %s as transient — retry, never reject', (_label, error) => {
    expect(interpretGatewayError(error)).toBe('transient');
  });
});
