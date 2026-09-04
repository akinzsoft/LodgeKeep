import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '../Card.jsx';

describe('<Card>', () => {
  it('renders a loading state as skeleton blocks, not a spinner (DESIGN_SYSTEM.md §2)', () => {
    render(<Card state="loading" />);
    expect(screen.getByTestId('card-loading')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders an empty state with a message and the caller-supplied action', () => {
    render(
      <Card state="empty" emptyMessage="No arrivals today" emptyAction={<button>Add reservation</button>} />
    );
    expect(screen.getByText('No arrivals today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add reservation' })).toBeInTheDocument();
  });

  it('renders an error state as an alert, so assistive tech announces it', () => {
    render(<Card state="error" errorMessage="Could not load reservations." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load reservations.');
  });

  it('renders children in the default (success) state', () => {
    render(
      <Card>
        <p>Real content</p>
      </Card>
    );
    expect(screen.getByText('Real content')).toBeInTheDocument();
  });

  it('renders an optional title', () => {
    render(<Card title="Today’s arrivals">content</Card>);
    expect(screen.getByRole('heading', { name: 'Today’s arrivals' })).toBeInTheDocument();
  });
});
