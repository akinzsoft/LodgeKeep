'use strict';

/**
 * Unit tests for the setup module's pure resolution functions — no database,
 * no fixtures. These are exactly the functions that let PLAN.md Phase 1
 * close its own "tax effective-dating" gate without needing Phase 2's
 * `folio_line_items` to exist (see this session's confirmed decision):
 * ARCHITECTURE.md §12.1's historical-reproducibility rule is about the
 * *resolution logic*, and that logic is provable in isolation.
 */

const { expandRoomNumberRange, resolveRate, resolveEffectiveTax } = require('../../src/modules/setup/service');
const { InvalidBulkRangeError } = require('../../src/modules/setup/errors');

describe('expandRoomNumberRange (TESTING.md SET-1)', () => {
  it('expands an inclusive range, e.g. 101-160 -> 60 rooms', () => {
    const numbers = expandRoomNumberRange('101', '160');
    expect(numbers).toHaveLength(60);
    expect(numbers[0]).toBe('101');
    expect(numbers[numbers.length - 1]).toBe('160');
  });

  it('preserves the wider zero-padding width', () => {
    expect(expandRoomNumberRange('01', '10')).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
    ]);
  });

  it('handles a single-room range', () => {
    expect(expandRoomNumberRange('205', '205')).toEqual(['205']);
  });

  it('rejects a non-numeric bound', () => {
    expect(() => expandRoomNumberRange('101A', '160')).toThrow(InvalidBulkRangeError);
  });

  it('rejects "to" before "from"', () => {
    expect(() => expandRoomNumberRange('160', '101')).toThrow(InvalidBulkRangeError);
  });

  it('rejects a range over 1000 rooms', () => {
    expect(() => expandRoomNumberRange('1', '1002')).toThrow(InvalidBulkRangeError);
  });
});

describe('resolveRate (TESTING.md SET-6 — "date override wins over rate-code base rate")', () => {
  const rateCode = { base_rate: '150.00' };

  it('falls back to the rate code base rate with no override', () => {
    expect(resolveRate(rateCode, undefined)).toBe('150.00');
  });

  it('uses the override when one exists for the date', () => {
    expect(resolveRate(rateCode, { rate: '225.00' })).toBe('225.00');
  });
});

describe('resolveEffectiveTax (ARCHITECTURE.md §12.1 — historical reproducibility)', () => {
  const versions = [
    { effective_from: '2026-01-01', effective_to: '2026-06-30', rate: '5.0000' },
    { effective_from: '2026-07-01', effective_to: null, rate: '7.5000' },
  ];

  it('resolves a date inside the first version to the first version', () => {
    expect(resolveEffectiveTax(versions, '2026-03-15')).toEqual(versions[0]);
  });

  it('resolves a date after the rate change to the new version', () => {
    expect(resolveEffectiveTax(versions, '2026-08-01')).toEqual(versions[1]);
  });

  it('a date BEFORE the rate change still resolves to the OLD version, even queried after the change exists — this is the whole rule', () => {
    // Simulates: the tax rate changed on 2026-07-01, but a folio audit runs
    // today (long after) for a charge posted on 2026-02-01. It must still
    // see the rate that was actually effective that day, not today's rate.
    expect(resolveEffectiveTax(versions, '2026-02-01').rate).toBe('5.0000');
  });

  it('resolves the boundary start date to the new version (effective_from is inclusive)', () => {
    expect(resolveEffectiveTax(versions, '2026-07-01')).toEqual(versions[1]);
  });

  it('resolves the boundary end date to the old version (effective_to is inclusive)', () => {
    expect(resolveEffectiveTax(versions, '2026-06-30')).toEqual(versions[0]);
  });

  it('returns null for a date before any version existed', () => {
    expect(resolveEffectiveTax(versions, '2025-12-31')).toBeNull();
  });

  it('is order-independent — the caller may pass versions in any order', () => {
    const reversed = [...versions].reverse();
    expect(resolveEffectiveTax(reversed, '2026-02-01')).toEqual(versions[0]);
  });
});
