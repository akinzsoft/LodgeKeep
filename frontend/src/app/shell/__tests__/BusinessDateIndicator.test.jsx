import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BusinessDateIndicator } from '../BusinessDateIndicator.jsx';

describe('<BusinessDateIndicator>', () => {
  it('renders the business date without shifting it through timezone parsing (ARCHITECTURE.md §6)', () => {
    // A date deliberately near a UTC day boundary — new Date('2026-01-01')
    // parsed as UTC and rendered in a negative-offset timezone would show
    // "Dec 31", which is exactly the bug this component must not have.
    render(<BusinessDateIndicator businessDate="2026-01-01" now={new Date(2026, 0, 1)} />);
    expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument();
  });

  it('flags when the business date differs from the wall-clock date', () => {
    render(<BusinessDateIndicator businessDate="2026-03-14" now={new Date(2026, 2, 15)} />);
    expect(screen.getByRole('note')).toHaveTextContent('differs from today');
  });

  it('shows no note when the business date matches today', () => {
    render(<BusinessDateIndicator businessDate="2026-03-15" now={new Date(2026, 2, 15)} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
