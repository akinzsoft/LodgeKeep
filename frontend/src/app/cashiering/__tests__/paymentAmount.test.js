import { describe, it, expect } from 'vitest';
import { defaultPaymentAmount, paymentAmountProblem, depositPortion } from '../paymentAmount.js';

describe('paymentAmount', () => {
  it('defaults to the balance only when something is owed', () => {
    expect(defaultPaymentAmount('100.00')).toBe('100.00');
    expect(defaultPaymentAmount('0.00')).toBe('');
    expect(defaultPaymentAmount('-20.00')).toBe('');
    expect(defaultPaymentAmount(null)).toBe('');
  });

  it('accepts positive amounts up to the ceiling', () => {
    for (const ok of ['1', '0.01', '250.5', '10000000.00']) expect(paymentAmountProblem(ok)).toBeNull();
  });

  it.each([[''], ['  '], ['-1'], ['0'], ['0.00'], ['1.234'], ['1e3'], ['1,000'], ['abc'], ['10000000.01']])('flags %p', (bad) => {
    expect(paymentAmountProblem(bad)).toEqual(expect.any(String));
  });

  it('deposit portion is the part above what is owed, exactly', () => {
    expect(depositPortion('150.00', '100.00')).toBe('50.00');
    expect(depositPortion('100.00', '100.00')).toBeNull();
    expect(depositPortion('40.00', '100.00')).toBeNull();
    expect(depositPortion('0.30', '0.10')).toBe('0.20');
  });

  it('on a settled or credit folio all of the amount is deposit', () => {
    expect(depositPortion('500.00', '0.00')).toBe('500.00');
    expect(depositPortion('30.00', '-20.00')).toBe('30.00');
  });

  it('has no deposit for an invalid amount', () => {
    expect(depositPortion('-5', '100.00')).toBeNull();
    expect(depositPortion('abc', '100.00')).toBeNull();
  });
});
