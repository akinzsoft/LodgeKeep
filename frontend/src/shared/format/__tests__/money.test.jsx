import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatMoney, Money } from '../money.jsx';

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
