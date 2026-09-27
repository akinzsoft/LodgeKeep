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
    render(<NotificationPopups popups={[order('1')]} onOpen={() => {}} onDismiss={() => {}} />);
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
    render(<NotificationPopups popups={[order('9')]} onOpen={onView} onDismiss={onDismiss} />);
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
    expect(screen.getByText('+2 more in the bell')).toBeInTheDocument();
  });

  it('falls back to "a guest" when no name was given', () => {
    render(<NotificationPopups popups={[order('1', { guestName: null })]} onDismiss={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Ordered by a guest');
  });

  describe('stock requests', () => {
    const requested = {
      id: '21',
      type: 'stock.transfer_requested',
      created_at: new Date().toISOString(),
      popup: true,
      read_at: null,
      payload: { requestId: 5, fromOutletName: 'Main Store', toOutletName: 'Main Bar', lineCount: 3 },
    };

    it('pops up who asked and for how much, and Open request opens it', async () => {
      const onOpen = vi.fn();
      render(<NotificationPopups popups={[requested]} onOpen={onOpen} onDismiss={() => {}} />);
      const card = screen.getByRole('alert', { name: 'Stock requested — Main Bar' });
      expect(card).toHaveTextContent('Request #5: 3 items from Main Store');
      await userEvent.click(screen.getByRole('button', { name: 'Open request' }));
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: '21' }));
    });

    it('offers no Open button when this user cannot open that screen', () => {
      render(<NotificationPopups popups={[requested]} onOpen={() => {}} canOpen={() => false} onDismiss={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Open request' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    });
  });
});
