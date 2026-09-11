import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckoutScreen } from '../CheckoutScreen.jsx';
import { renderQrOrderScreen, TOKEN } from './renderQrOrderScreen.jsx';

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  retryCheckout: vi.fn(),
  openPaystackPopup: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, qrOrderingApi: { createOrder: mocks.createOrder, retryCheckout: mocks.retryCheckout } };
});

vi.mock('../../../shared/paystack.js', () => ({ openPaystackPopup: mocks.openPaystackPopup }));

const CART = [{ menuItemId: '10', quantity: 2, name: 'Chapman', price: '20.00' }];

function StatusStub() {
  return <p>status screen</p>;
}
function RoomChargeStub() {
  return <p>room-charge screen</p>;
}

function renderScreen({ cart = CART, paymentMethod = 'card' } = {}) {
  return renderQrOrderScreen({
    element: <CheckoutScreen />,
    routePath: 'checkout',
    initialPath: { pathname: `/qr-order/${TOKEN}/checkout`, state: { cart, paymentMethod } },
    otherRoutes: [
      { path: 'orders/:id/status', element: <StatusStub /> },
      { path: 'orders/:id/room-charge', element: <RoomChargeStub /> },
    ],
  });
}

describe('<CheckoutScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows an honest empty-cart message when no cart was carried across', async () => {
    renderQrOrderScreen({ element: <CheckoutScreen />, routePath: 'checkout' });
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t find your order details');
  });

  it('shows the real order summary with an exact money total', async () => {
    renderScreen();
    expect(await screen.findByText('2 × Chapman')).toBeInTheDocument();
    expect(await screen.findAllByText(/40\.00/)).toHaveLength(2); // one line total, one grand total — same amount here since there's only one line
  });

  it('places a card order and opens the real embedded Paystack popup with the real access code, then goes to the status screen', async () => {
    mocks.createOrder.mockResolvedValue({ id: '77', accessCode: 'ac_1' });
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
    renderScreen();

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    await waitFor(() => expect(mocks.openPaystackPopup).toHaveBeenCalledWith(expect.objectContaining({ accessCode: 'ac_1' })));
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ token: TOKEN, paymentMethod: 'card', guestContact: 'guest@example.com', items: [{ menu_item_id: '10', quantity: 2 }] })
    );
    expect(await screen.findByText('status screen')).toBeInTheDocument();
  });

  it('shows a real, actionable error on the honest-202 partial-success path, never a silent drop', async () => {
    mocks.createOrder.mockResolvedValue({ id: '78', checkoutError: 'Paystack unreachable' });
    renderScreen();

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Paystack unreachable');

    mocks.retryCheckout.mockResolvedValue({ accessCode: 'ac_2' });
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
    await userEvent.click(screen.getByRole('button', { name: 'Retry payment' }));

    expect(mocks.retryCheckout).toHaveBeenCalledWith({ token: TOKEN, id: '78' });
    await waitFor(() => expect(screen.getByText('status screen')).toBeInTheDocument());
  });

  it('navigates a room-charge order straight to the room-charge verification screen, never opening a payment popup', async () => {
    mocks.createOrder.mockResolvedValue({ id: '79', status: 'awaiting_payment', payment_status: 'unpaid' });
    renderScreen({ paymentMethod: 'room_charge' });

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByText('room-charge screen')).toBeInTheDocument();
    expect(mocks.openPaystackPopup).not.toHaveBeenCalled();
  });

  it('surfaces a real backend error when order creation itself fails', async () => {
    mocks.createOrder.mockRejectedValue(new Error('boom'));
    renderScreen();

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not place this order.');
  });
});
