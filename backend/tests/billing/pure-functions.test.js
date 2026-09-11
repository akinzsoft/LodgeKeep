'use strict';

const { addOneMonth } = require('../../src/modules/billing/service');

describe('addOneMonth (PLAN.md Phase 5) — pure, billing-period arithmetic', () => {
  it('adds a plain calendar month with no month-end complication', () => {
    expect(addOneMonth('2027-03-15')).toBe('2027-04-15');
  });

  it('clamps Jan 31 to Feb 28 in a non-leap year, never overflowing to March', () => {
    expect(addOneMonth('2027-01-31')).toBe('2027-02-28');
  });

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(addOneMonth('2028-01-31')).toBe('2028-02-29');
  });

  it('rolls over the year boundary correctly', () => {
    expect(addOneMonth('2027-12-01')).toBe('2028-01-01');
  });

  it('clamps Dec 31 to Jan 31 (both 31-day months, no clamping actually needed, but proves the boundary is exact)', () => {
    expect(addOneMonth('2027-12-31')).toBe('2028-01-31');
  });
});
