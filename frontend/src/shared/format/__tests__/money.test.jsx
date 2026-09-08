import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatMoney, Money, isBalanceSettled, describeBalanceState } from '../money.jsx';

describe('formatMoney', () => {
  it('formats a DECIMAL string with the correct currency symbol', () => {
    expect(formatMoney('1250.00', 'NGN')).toBe('₦1,250.00');
    expect(formatMoney('1250.00', 'GBP')).toBe('£1,250.00');
  });

  it('always shows the currency — TESTING.md FE-3', () => {
    const result = formatMoney('0.00', 'USD');
    expect(result).toContain('$');
  });

  it('throws rather than silently defaulting a missing currency', () => {
    expect(() => formatMoney('10.00', undefined)).toThrow(/requires a currencyCode/);
  });

  it('throws on a non-numeric amount rather than rendering garbage', () => {
    expect(() => formatMoney('not-a-number', 'USD')).toThrow(/non-numeric/);
  });
});

describe('<Money>', () => {
  it('renders with tabular-nums so a column of amounts aligns (DESIGN_SYSTEM.md §1)', () => {
    render(<Money amount="1250.00" currencyCode="NGN" />);
    const el = screen.getByText('₦1,250.00');
    expect(el).toHaveClass('tabular-nums');
  });
});

/**
 * Gap closure (user-reported): "wen payment is done disable the book
 * button and payment buttons." Both functions do only string-identity
 * checks, never a numeric parse (ARCHITECTURE.md §1: money is exact,
 * always) — every branch, including the credit (negative-balance) one, is
 * exercised here.
 */
describe('isBalanceSettled', () => {
  it('is true for an exact zero balance', () => {
    expect(isBalanceSettled('0.00')).toBe(true);
  });

  it('is true for a negative (credit) balance', () => {
    expect(isBalanceSettled('-20.00')).toBe(true);
  });

  it('is false for a balance still owing', () => {
    expect(isBalanceSettled('150.00')).toBe(false);
  });

  it('is false for null/undefined — never treated as settled', () => {
    expect(isBalanceSettled(null)).toBe(false);
    expect(isBalanceSettled(undefined)).toBe(false);
  });
});

describe('describeBalanceState', () => {
  it('describes a zero balance as paid in full', () => {
    expect(describeBalanceState('0.00')).toEqual({ tone: 'success', label: 'Paid in full' });
  });

  it('describes a negative balance as a credit', () => {
    expect(describeBalanceState('-20.00')).toEqual({ tone: 'info', label: 'Credit balance' });
  });

  it('returns null while a balance is still owing — no pill, the owing amount is its own signal', () => {
    expect(describeBalanceState('150.00')).toBeNull();
  });
});
