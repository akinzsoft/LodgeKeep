import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrderStatusScreen } from '../OrderStatusScreen.jsx';
import { renderQrOrderScreen, TOKEN } from './renderQrOrderScreen.jsx';

const mocks = vi.hoisted(() => ({
  getOrderStatus: vi.fn(),
  retryCheckout: vi.fn(),
  confirmCardPayment: vi.fn(),
  openPaystackPopup: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    qrOrderingApi: { getOrderStatus: mocks.getOrderStatus, retryCheckout: mocks.retryCheckout, confirmCardPayment: mocks.confirmCardPayment },
  };
});

vi.mock('../../../shared/paystack.js', () => ({ openPaystackPopup: mocks.openPaystackPopup }));

function RoomChargeStub() {
  return <p>room-charge screen</p>;
}

function renderScreen() {
  return renderQrOrderScreen({
    element: <OrderStatusScreen />,
    routePath: 'orders/:id/status',
    initialPath: `/qr-order/${TOKEN}/orders/9/status`,
    otherRoutes: [{ path: 'orders/:id/room-charge', element: <RoomChargeStub /> }],
  });
}

function baseOrder(overrides) {
  return { id: '9', payment_method: 'card', payment_status: 'unpaid', status: 'awaiting_payment', rejected_reason: null, ...overrides };
}

describe('<OrderStatusScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['awaiting_payment', 'Awaiting payment'],
    ['received', 'Received'],
    ['preparing', 'Preparing'],
    ['on_the_way', 'On the way'],
    ['rejected', 'Rejected'],
    ['auto_rejected', 'Auto-rejected'],
  ])('renders the real status pill for "%s"', async (status, label) => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder({ status, payment_method: 'room_charge', payment_status: 'charged_to_room' }));
    renderScreen();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it.each([
    ['unpaid', 'Unpaid'],
    ['paid', 'Paid'],
    ['charged_to_room', 'Charged to room'],
    ['refunded', 'Refunded'],
  ])('renders the real payment pill for "%s"', async (paymentStatus, label) => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder({ payment_method: 'room_charge', payment_status: paymentStatus, status: 'received' }));
    renderScreen();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('shows a real backend error when the order fails to load, with a retry', async () => {
    mocks.getOrderStatus.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(baseOrder({ status: 'received', payment_status: 'paid' }));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this order.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Received')).toBeInTheDocument();
  });

  it('offers to retry checkout for a still-unpaid card order, opening the real popup on success', async () => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder());
    mocks.retryCheckout.mockResolvedValue({ accessCode: 'ac_9' });
    mocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
    renderScreen();

    await userEvent.click(await screen.findByRole('button', { name: 'Retry checkout' }));
    expect(mocks.retryCheckout).toHaveBeenCalledWith({ token: TOKEN, id: '9' });
    await waitFor(() => expect(mocks.openPaystackPopup).toHaveBeenCalledWith(expect.objectContaining({ accessCode: 'ac_9' })));
  });

  it('"I\'ve already paid" re-verifies against the real gateway and updates the shown status', async () => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder());
    mocks.confirmCardPayment.mockResolvedValue({ guestOrder: baseOrder({ payment_status: 'paid', status: 'received' }) });
    renderScreen();

    await userEvent.click(await screen.findByRole('button', { name: "I’ve already paid" }));
    expect(mocks.confirmCardPayment).toHaveBeenCalledWith({ token: TOKEN, id: '9' });
    expect(await screen.findByText('Paid')).toBeInTheDocument();
  });

  it('offers no "Complete payment" section once a card order is genuinely paid', async () => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder({ payment_status: 'paid', status: 'received' }));
    renderScreen();
    await screen.findByText('Received');
    expect(screen.queryByRole('button', { name: 'Retry checkout' })).not.toBeInTheDocument();
  });

  it('links an unpaid room-charge order back to the verification screen', async () => {
    mocks.getOrderStatus.mockResolvedValue(baseOrder({ payment_method: 'room_charge', payment_status: 'unpaid', status: 'awaiting_payment' }));
    renderScreen();

    await userEvent.click(await screen.findByRole('button', { name: 'Verify and charge to my room' }));
    expect(await screen.findByText('room-charge screen')).toBeInTheDocument();
  });

  it('polls while the order is still moving, and stops once it reaches a stable end state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.getOrderStatus
      .mockResolvedValueOnce(baseOrder({ payment_method: 'room_charge', payment_status: 'unpaid', status: 'received' }))
      .mockResolvedValueOnce(baseOrder({ payment_method: 'room_charge', payment_status: 'charged_to_room', status: 'on_the_way' }));
    renderScreen();

    expect(await screen.findByText('Received')).toBeInTheDocument();
    expect(mocks.getOrderStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(await screen.findByText('On the way')).toBeInTheDocument();
    expect(mocks.getOrderStatus).toHaveBeenCalledTimes(2);

    // Now on a stable end state (`on_the_way`) — a further interval tick polls no more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(mocks.getOrderStatus).toHaveBeenCalledTimes(2);
  });
});
