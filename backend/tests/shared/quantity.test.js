'use strict';

/**
 * Pure-function tests for `src/shared/quantity.js` — PLAN.md Phase 6's
 * exact BigInt-scaled quantity arithmetic, mirroring `tests/shared/money.test.js`'s
 * own coverage shape exactly (every function, every sign combination,
 * every rounding edge case for `extendedCost`'s cross-precision
 * rounding).
 */

const {
  sumQuantity,
  negateQuantity,
  multiplyQuantityByInteger,
  compareQuantity,
  extendedCost,
} = require('../../src/shared/quantity');

describe('quantity.js — exact decimal quantity arithmetic', () => {
  describe('sumQuantity', () => {
    it('sums an empty array to zero', () => {
      expect(sumQuantity([])).toBe('0.000');
    });

    it('sums positive values exactly', () => {
      expect(sumQuantity(['1.500', '2.250', '0.001'])).toBe('3.751');
    });

    it('sums mixed-sign values exactly', () => {
      expect(sumQuantity(['10.000', '-4.500', '-0.500'])).toBe('5.000');
    });

    it('sums to a negative total', () => {
      expect(sumQuantity(['-1.000', '-2.500'])).toBe('-3.500');
    });

    it('handles a value with no fractional part', () => {
      expect(sumQuantity(['5', '5.000'])).toBe('10.000');
    });
  });

  describe('negateQuantity', () => {
    it('negates a positive value', () => {
      expect(negateQuantity('2.500')).toBe('-2.500');
    });

    it('negates a negative value back to positive', () => {
      expect(negateQuantity('-1.000')).toBe('1.000');
    });

    it('negates zero to zero, not "-0.000"', () => {
      expect(negateQuantity('0.000')).toBe('0.000');
    });
  });

  describe('multiplyQuantityByInteger', () => {
    it('multiplies a fractional per-unit quantity by a whole count', () => {
      expect(multiplyQuantityByInteger('0.125', 4)).toBe('0.500');
    });

    it('multiplies by 1 unchanged', () => {
      expect(multiplyQuantityByInteger('50.000', 1)).toBe('50.000');
    });

    it('multiplies by a large count exactly', () => {
      expect(multiplyQuantityByInteger('12.345', 100)).toBe('1234.500');
    });

    it('multiplies by zero to zero', () => {
      expect(multiplyQuantityByInteger('99.999', 0)).toBe('0.000');
    });
  });

  describe('compareQuantity', () => {
    it('returns -1 when a < b', () => {
      expect(compareQuantity('1.000', '2.000')).toBe(-1);
    });

    it('returns 1 when a > b', () => {
      expect(compareQuantity('2.000', '1.000')).toBe(1);
    });

    it('returns 0 for exactly equal values', () => {
      expect(compareQuantity('5.500', '5.500')).toBe(0);
    });

    it('treats zero and negative-zero-shaped strings as equal', () => {
      expect(compareQuantity('0.000', '-0.000')).toBe(0);
    });

    it('compares a negative against a positive correctly', () => {
      expect(compareQuantity('-1.000', '0.000')).toBe(-1);
    });
  });

  describe('extendedCost — the one cross-precision (2dp money × 3dp quantity) function', () => {
    it('computes an exact product with no rounding needed', () => {
      expect(extendedCost('5.00', '2.000')).toBe('10.00');
    });

    it('rounds a fractional cent down (below the halfway point)', () => {
      // 5.00 * 0.001 = 0.005 -> exactly halfway; covered by its own case below.
      // 4.00 * 0.001 = 0.004 -> rounds down to 0.00.
      expect(extendedCost('4.00', '0.001')).toBe('0.00');
    });

    it('rounds a fractional cent up (above the halfway point)', () => {
      // 6.00 * 0.001 = 0.006 -> rounds up to 0.01.
      expect(extendedCost('6.00', '0.001')).toBe('0.01');
    });

    it('rounds exactly halfway up, matching money.js\'s own half-up convention', () => {
      // 5.00 * 0.001 = 0.005 -> exactly halfway, rounds up to 0.01.
      expect(extendedCost('5.00', '0.001')).toBe('0.01');
    });

    it('produces a negative cost for a negative (deducting) quantity', () => {
      expect(extendedCost('5.00', '-2.000')).toBe('-10.00');
    });

    it('produces a negative cost for a negative unit cost with a positive quantity', () => {
      expect(extendedCost('-5.00', '2.000')).toBe('-10.00');
    });

    it('produces a positive cost when both factors are negative', () => {
      expect(extendedCost('-5.00', '-2.000')).toBe('10.00');
    });

    it('computes zero cost for a zero quantity', () => {
      expect(extendedCost('9.99', '0.000')).toBe('0.00');
    });

    it('computes zero cost for a zero unit cost', () => {
      expect(extendedCost('0.00', '123.456')).toBe('0.00');
    });

    it('handles a real-shaped recipe deduction (fractional ml at a real spirit cost)', () => {
      // ₦5.00/ml * -50.000ml (one cocktail's worth deducted) = -₦250.00.
      expect(extendedCost('5.00', '-50.000')).toBe('-250.00');
    });
  });
});
