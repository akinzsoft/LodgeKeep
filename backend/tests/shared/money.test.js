'use strict';

/**
 * `src/shared/money.js` — ARCHITECTURE.md §1/§12: exact DECIMAL arithmetic,
 * never a float. `sumMoney`/`divideMoney` already had indirect coverage via
 * the reporting module (PLAN.md Phase 3); `percentOfMoney`/`negateMoney`/
 * `compareMoney` are new for PLAN.md Phase 2.5's cashiering tax engine and
 * signed folio line items, so they get direct unit tests here rather than
 * only exercised indirectly through a higher-level module.
 */

const { sumMoney, divideMoney, percentOfMoney, negateMoney, compareMoney } = require('../../src/shared/money');

describe('src/shared/money.js', () => {
  describe('sumMoney', () => {
    it('sums exactly, including negative (payment) values', () => {
      expect(sumMoney(['100.00', '-40.00', '5.50'])).toBe('65.50');
    });

    it('sums to 0.00 for an empty array', () => {
      expect(sumMoney([])).toBe('0.00');
    });
  });

  describe('divideMoney', () => {
    it('rounds half-up to the nearest cent', () => {
      expect(divideMoney('10.00', 3)).toBe('3.33');
      expect(divideMoney('10.01', 2)).toBe('5.01');
    });

    it('returns 0.00 for a zero count rather than dividing by zero', () => {
      expect(divideMoney('50.00', 0)).toBe('0.00');
    });
  });

  describe('percentOfMoney', () => {
    it('computes an exact percentage at 4-decimal rate precision', () => {
      expect(percentOfMoney('100.00', '7.5000')).toBe('7.50');
      expect(percentOfMoney('200.00', '7.5000')).toBe('15.00');
    });

    it('rounds half-up on a genuine fractional-cent boundary', () => {
      // 33.33 * 5% = 1.6665 -> rounds to 1.67 (half-up), not 1.66 (float-toward-even).
      expect(percentOfMoney('33.33', '5.0000')).toBe('1.67');
    });

    it('handles a negative base amount (a refund line taxed the same way as its original charge)', () => {
      expect(percentOfMoney('-100.00', '7.5000')).toBe('-7.50');
    });

    it('returns 0.00 for a 0% rate', () => {
      expect(percentOfMoney('500.00', '0.0000')).toBe('0.00');
    });
  });

  describe('negateMoney', () => {
    it('flips sign exactly', () => {
      expect(negateMoney('12.50')).toBe('-12.50');
      expect(negateMoney('-5.00')).toBe('5.00');
      expect(negateMoney('0.00')).toBe('0.00');
    });
  });

  describe('compareMoney', () => {
    it('compares exactly, never via float subtraction', () => {
      expect(compareMoney('10.00', '9.99')).toBe(1);
      expect(compareMoney('9.99', '10.00')).toBe(-1);
      expect(compareMoney('10.00', '10.00')).toBe(0);
      expect(compareMoney('-1.00', '0.00')).toBe(-1);
    });
  });
});
