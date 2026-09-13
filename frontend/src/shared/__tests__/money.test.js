import { describe, it, expect } from 'vitest';
import { sumMoney, multiplyMoney, percentOfMoney } from '../money.js';

describe('sumMoney', () => {
  it('sums an array of decimal strings exactly', () => {
    expect(sumMoney(['20.00', '1.50', '5.00', '2.00'])).toBe('28.50');
  });

  it('sums to "0.00" for an empty array', () => {
    expect(sumMoney([])).toBe('0.00');
  });

  it('handles a negative value in the sum', () => {
    expect(sumMoney(['10.00', '-3.25'])).toBe('6.75');
  });
});

describe('multiplyMoney', () => {
  it('multiplies by a positive integer quantity exactly', () => {
    expect(multiplyMoney('20.00', 3)).toBe('60.00');
  });

  it('multiplies by zero', () => {
    expect(multiplyMoney('20.00', 0)).toBe('0.00');
  });
});

describe('percentOfMoney', () => {
  it('computes a whole-number percent exactly', () => {
    expect(percentOfMoney('20.00', '10')).toBe('2.00');
  });

  it('computes a fractional percent, rounding half-up', () => {
    // 12.5% of 107.50 = 13.4375 -> rounds to 13.44, never truncated to 13.43.
    expect(percentOfMoney('107.50', '12.5')).toBe('13.44');
  });

  it('a zero or blank percent produces zero', () => {
    expect(percentOfMoney('20.00', '0')).toBe('0.00');
    expect(percentOfMoney('20.00', '')).toBe('0.00');
  });

  it('never uses floating-point arithmetic — a value that would misround under Number() still rounds correctly', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754 — a real value chosen to fail if this
    // function ever used Number()/parseFloat() internally.
    expect(percentOfMoney('10.00', '1')).toBe('0.10');
  });

  it('bug fix: a rate with more than 2 decimal places is genuinely rounded, never silently truncated', () => {
    // 5.999% of 100,000.00 is exactly 5999.00 — an earlier draft of this
    // function scaled the rate to only 2 decimal places (matching
    // `taxes.rate`'s own precision would need 4, per the backend's own
    // `percentOfMoney`), which silently chopped "5.999" down to "5.99" and
    // returned the wrong 5990.00 — a real ₦9.00 discrepancy.
    expect(percentOfMoney('100000.00', '5.999')).toBe('5999.00');
  });

  it('a negative amount rounds the same way as a positive one (sign handled once, not per-branch)', () => {
    expect(percentOfMoney('-20.00', '10')).toBe('-2.00');
  });
});
