import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckoutScreen } from '../CheckoutScreen.jsx';
import { ApiError } from '../../../shared/api/index.js';
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

function renderScreen({ cart = CART, paymentMethod = 'card', serviceChargePercent = null } = {}) {
  return renderQrOrderScreen({
    element: <CheckoutScreen />,
    routePath: 'checkout',
    initialPath: { pathname: `/qr-order/${TOKEN}/checkout`, state: { cart, paymentMethod, serviceChargePercent } },
    otherRoutes: [
      { path: 'orders/:id/status', element: <StatusStub /> },
      { path: 'orders/:id/room-charge', element: <RoomChargeStub /> },
    ],
  });
}

describe('<CheckoutScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    window.sessionStorage.clear();
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

  it('shows no service charge line when the outlet charges none on QR orders', async () => {
    renderScreen();
    await screen.findByText('2 × Chapman');
    expect(screen.queryByText(/Service charge/)).not.toBeInTheDocument();
  });

  it('shows the service charge line and a total that includes it before the guest confirms', async () => {
    renderScreen({ serviceChargePercent: '7.50' });
    expect(await screen.findByText('Service charge (7.50%)')).toBeInTheDocument();
    expect(screen.getByText('Service charge (7.50%)').closest('div')).toHaveTextContent(/3\.00$/); // 7.5% of 40.00
    expect(screen.getByText('Total').closest('div')).toHaveTextContent(/43\.00$/);
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

  it('a double tap on Place order creates one order and opens one payment window', async () => {
    let release;
    mocks.createOrder.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
    renderScreen();

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    const form = screen.getByRole('button', { name: 'Place order' }).closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.createOrder).toHaveBeenCalledTimes(1);

    await act(async () => release({ id: '77', accessCode: 'ac_1' }));
    expect(await screen.findByText('status screen')).toBeInTheDocument();
    expect(mocks.openPaystackPopup).toHaveBeenCalledTimes(1);
  });

  it('shows "Opening payment page…" and then an "Open payment page" link if the window never appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.createOrder.mockResolvedValue({ id: '77', accessCode: 'ac_1', authorizationUrl: 'https://checkout.paystack.com/server-url' });
      mocks.openPaystackPopup.mockImplementation(() => new Promise(() => {}));
      renderScreen();

      await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opening payment page…'));
      expect(screen.queryByRole('link', { name: 'Open payment page' })).not.toBeInTheDocument();

      await act(async () => vi.advanceTimersByTime(5100));
      const link = screen.getByRole('link', { name: 'Open payment page' });
      expect(link).toHaveAttribute('href', 'https://checkout.paystack.com/server-url');
      expect(link).toHaveAttribute('target', '_blank');

      // The guest who paid on that page can still reach the order.
      await userEvent.click(screen.getByRole('button', { name: 'I have paid, view order status' }));
      expect(await screen.findByText('status screen')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds the link from the access code when the server sent no authorization URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.createOrder.mockResolvedValue({ id: '77', accessCode: 'ac_7' });
      mocks.openPaystackPopup.mockImplementation(() => new Promise(() => {}));
      renderScreen();
      await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
      await waitFor(() => expect(mocks.openPaystackPopup).toHaveBeenCalled());
      await act(async () => vi.advanceTimersByTime(5100));
      expect(screen.getByRole('link', { name: 'Open payment page' })).toHaveAttribute('href', 'https://checkout.paystack.com/ac_7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the retry screen when the Paystack script cannot load', async () => {
    mocks.createOrder.mockResolvedValue({ id: '77', accessCode: 'ac_1' });
    mocks.openPaystackPopup.mockRejectedValue(new Error('no script'));
    renderScreen();
    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/Could not open the payment window/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry payment' })).toBeInTheDocument();
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

  it('clears the remembered cart once the order is placed, but keeps it if placing fails', async () => {
    const key = `lodgekeep.qr-cart.${TOKEN}`;
    window.sessionStorage.setItem(key, JSON.stringify({ 10: 2 }));
    mocks.createOrder.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: '80' });
    renderScreen({ paymentMethod: 'room_charge' });

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not place this order.');
    expect(window.sessionStorage.getItem(key)).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('room-charge screen')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('surfaces a real backend error when order creation itself fails', async () => {
    mocks.createOrder.mockRejectedValue(new Error('boom'));
    renderScreen();

    await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not place this order.');
  });

  describe('gap closure: the stock-out override guard', () => {
    function stockRejection(items) {
      return new ApiError({ code: 'BUSINESS_RULE_INSUFFICIENT_STOCK', message: 'Insufficient stock.', details: { items } });
    }

    it('shows a yes/no prompt naming the item — never a free-text field — instead of the generic error banner', async () => {
      mocks.createOrder.mockRejectedValueOnce(stockRejection([{ name: 'Chapman mix' }]));
      renderScreen();

      await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

      expect(await screen.findByText(/Chapman mix may be running low/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Yes, order anyway' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'No, go back' })).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); // no free-text reason field
      expect(screen.queryByText('Insufficient stock.')).not.toBeInTheDocument();
    });

    it('"Yes, order anyway" resubmits with acknowledge_low_stock: true and proceeds normally on success', async () => {
      mocks.createOrder.mockRejectedValueOnce(stockRejection([{ name: 'Chapman mix' }]));
      mocks.createOrder.mockResolvedValueOnce({ id: '81', accessCode: 'ac_3' });
      mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
      renderScreen();

      await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
      await screen.findByRole('button', { name: 'Yes, order anyway' });

      await userEvent.click(screen.getByRole('button', { name: 'Yes, order anyway' }));

      expect(mocks.createOrder).toHaveBeenLastCalledWith(expect.objectContaining({ acknowledgeLowStock: true }));
      await waitFor(() => expect(screen.getByText('status screen')).toBeInTheDocument());
    });

    it('"No, go back" returns to the order form unchanged, submitting nothing further', async () => {
      mocks.createOrder.mockRejectedValueOnce(stockRejection([{ name: 'Chapman mix' }]));
      renderScreen();

      await userEvent.type(await screen.findByLabelText(/Email/), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
      await screen.findByRole('button', { name: 'No, go back' });

      await userEvent.click(screen.getByRole('button', { name: 'No, go back' }));

      expect(screen.getByRole('button', { name: 'Place order' })).toBeInTheDocument();
      expect(mocks.createOrder).toHaveBeenCalledTimes(1);
    });
  });
});
