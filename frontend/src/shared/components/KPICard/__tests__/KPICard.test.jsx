import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KPICard } from '../KPICard.jsx';

describe('<KPICard>', () => {
  it('never renders a stale value while loading — the loading branch does not read value at all', () => {
    render(<KPICard label="Room nights booked" value="1,204" state="loading" />);
    expect(screen.queryByText('1,204')).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-loading')).toBeInTheDocument();
  });

  it('renders the numeral with tabular figures once loaded (DESIGN_SYSTEM.md §1)', () => {
    render(<KPICard label="Room nights booked" value="1,204" domain="money" />);
    const value = screen.getByText('1,204');
    expect(value).toHaveClass('tabular-nums');
  });

  it('renders an empty state', () => {
    render(<KPICard label="Revenue today" state="empty" emptyMessage="No charges posted yet" />);
    expect(screen.getByText('No charges posted yet')).toBeInTheDocument();
  });

  it('renders an error state', () => {
    render(<KPICard label="Revenue today" state="error" errorMessage="Could not load revenue." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load revenue.');
  });

  it('always shows the label', () => {
    render(<KPICard label="Occupancy" value="82%" />);
    expect(screen.getByText('Occupancy')).toBeInTheDocument();
  });
});
