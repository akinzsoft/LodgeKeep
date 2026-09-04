'use strict';

/**
 * Unit tests for the reservations module's pure functions — no database, no
 * fixtures. Same discipline Phase 1's `tests/setup/pure-functions.test.js`
 * established: the state machine, the date-range expansion, and the
 * early/late fee rule are all provable in isolation from the concurrency-
 * and-transaction-heavy parts of the service, which `tests/reservations/
 * reservations.test.js` exercises for real over HTTP instead.
 */

const { generateUlid, expandStayDates, isValidTransition, computeEarlyLateFee } = require('../../src/modules/reservations/service');

describe('generateUlid (ARCHITECTURE.md §10)', () => {
  it('produces a 26-character string from Crockford\'s base32 alphabet', () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is lexically sortable by timestamp — a later millisecond sorts after an earlier one', () => {
    const earlier = generateUlid(1_700_000_000_000);
    const later = generateUlid(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it('two calls at the same millisecond differ in their random suffix', () => {
    const a = generateUlid(1_700_000_000_000);
    const b = generateUlid(1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });
});

describe('expandStayDates', () => {
  it('a two-night stay expands to exactly two dates, arrival inclusive, departure exclusive', () => {
    expect(expandStayDates('2026-06-01', '2026-06-03')).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('a one-night stay expands to one date', () => {
    expect(expandStayDates('2026-06-01', '2026-06-02')).toEqual(['2026-06-01']);
  });

  it('crosses a month boundary correctly', () => {
    expect(expandStayDates('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01']);
  });
});

describe('isValidTransition (ARCHITECTURE.md §11, plus waitlisted)', () => {
  it.each([
    ['waitlisted', 'confirmed'],
    ['waitlisted', 'cancelled'],
    ['tentative', 'confirmed'],
    ['tentative', 'expired'],
    ['tentative', 'cancelled'],
    ['confirmed', 'checked_in'],
    ['confirmed', 'cancelled'],
    ['confirmed', 'no_show'],
    ['checked_in', 'checked_out'],
  ])('allows %s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each([
    ['checked_out', 'cancelled'],
    ['checked_out', 'checked_in'],
    ['cancelled', 'confirmed'],
    ['no_show', 'confirmed'],
    ['confirmed', 'waitlisted'],
    ['checked_in', 'confirmed'],
  ])('rejects %s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });

  it('rejects an unknown status entirely', () => {
    expect(isValidTransition('bogus', 'confirmed')).toBe(false);
  });
});

describe('computeEarlyLateFee (TESTING.md FD-5/FD-6)', () => {
  it('FD-6: checking out after the scheduled time posts the late fee', () => {
    const fee = computeEarlyLateFee({
      scheduledCheckoutTime: '11:00',
      actualCheckoutTime: '14:00',
      lateCheckoutFee: '25.00',
    });
    expect(fee).toEqual({ type: 'late_checkout', amount: '25.00' });
  });

  it('FD-5: checking out before the early-departure cutoff posts the early fee instead', () => {
    const fee = computeEarlyLateFee({
      scheduledCheckoutTime: '11:00',
      actualCheckoutTime: '06:00',
      earlyCutoffTime: '08:00',
      earlyDepartureFee: '50.00',
      lateCheckoutFee: '25.00',
    });
    expect(fee).toEqual({ type: 'early_departure', amount: '50.00' });
  });

  it('checking out on time posts no fee', () => {
    const fee = computeEarlyLateFee({
      scheduledCheckoutTime: '11:00',
      actualCheckoutTime: '10:30',
      earlyCutoffTime: '08:00',
    });
    expect(fee).toBeNull();
  });

  it('checking out exactly at the scheduled time posts no fee', () => {
    const fee = computeEarlyLateFee({ scheduledCheckoutTime: '11:00', actualCheckoutTime: '11:00' });
    expect(fee).toBeNull();
  });
});
