import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationPopups } from '../NotificationPopups.jsx';

function order(id, payload = {}) {
  return {
    id,
    type: 'qr_ordering.guest_order_placed',
    created_at: new Date().toISOString(),
    popup: true,
    read_at: null,
    payload: {
      tableLabel: 'Table 4',
      outletName: 'Main Bar',
      guestName: 'John',
      paymentMethod: 'room_charge',
      items: [
        { name: 'Chapman', quantity: 2 },
        { name: 'Coke', quantity: 1 },
      ],
      total: '6000.00',
      currency: 'NGN',
      ...payload,
    },
  };
}

describe('<NotificationPopups>', () => {
  it('renders nothing with no popups', () => {
    const { container } = render(<NotificationPopups popups={[]} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows who ordered, where, what, how it was paid, and the total', () => {
    render(<NotificationPopups popups={[order('1')]} onView={() => {}} onDismiss={() => {}} />);
    const card = screen.getByRole('alert', { name: 'New QR order' });
    expect(card).toHaveTextContent('Table 4 · Main Bar');
    expect(card).toHaveTextContent('Ordered by John');
    expect(card).toHaveTextContent('2×Chapman');
    expect(card).toHaveTextContent('Charged to room');
    expect(card).toHaveTextContent(/6,000\.00/);
  });

  it('View orders and Dismiss call back with the right notification', async () => {
    const onView = vi.fn();
    const onDismiss = vi.fn();
    render(<NotificationPopups popups={[order('9')]} onView={onView} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: 'View orders' }));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: '9' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('9');
  });

  it('hides View orders for a user who cannot open POS', () => {
    render(<NotificationPopups popups={[order('1')]} onDismiss={() => {}} />);
    expect(screen.queryByRole('button', { name: 'View orders' })).not.toBeInTheDocument();
  });

  it('shows at most three cards and counts the rest', () => {
    render(<NotificationPopups popups={['1', '2', '3', '4', '5'].map((id) => order(id))} onDismiss={() => {}} />);
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getByText('+2 more new orders in the bell')).toBeInTheDocument();
  });

  it('falls back to "a guest" when no name was given', () => {
    render(<NotificationPopups popups={[order('1', { guestName: null })]} onDismiss={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Ordered by a guest');
  });
});
