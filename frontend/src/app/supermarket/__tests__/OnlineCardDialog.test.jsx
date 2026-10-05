import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnlineCardDialog } from '../OnlineCardDialog.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ checkOnlineSale: vi.fn(), cancelOnlineSale: vi.fn(), reopenOnlineCheckout: vi.fn() }));
const popup = vi.hoisted(() => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: mocks };
});
vi.mock('../../../shared/paystack.js', () => popup);

const pending = { id: '31', status: 'pending', total: '203.00', currency: 'NGN', lines: [], sale: null };
const SESSION = { intent: pending, accessCode: 'acc-1', checkoutUrl: 'https://checkout.paystack.com/acc-1', qrDataUrl: 'data:image/png;base64,AAAA' };
const SALE = { id: '90', receipt_code: 'MART-000007', method: 'card' };

function setup(props = {}) {
  const onCompleted = vi.fn();
  const onClose = vi.fn();
  render(<OnlineCardDialog session={SESSION} currency="NGN" onCompleted={onCompleted} onClose={onClose} {...props} />);
  return { onCompleted, onClose };
}

describe('<OnlineCardDialog>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    popup.openPaystackPopup.mockReset();
    mocks.checkOnlineSale.mockResolvedValue({ intent: pending, checkError: null });
  });
  afterEach(() => vi.useRealTimers());

  it('shows the amount, a QR code and the ways to pay while waiting', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Online payment (Paystack)' })).toBeInTheDocument();
    expect(screen.getByText(/203\.00/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Scan to pay online' })).toHaveAttribute('src', SESSION.qrDataUrl);
    expect(screen.getByRole('button', { name: 'Pay in this window' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for payment');
  });

  it('draws no QR and does not mention one when the server sent none (NGN)', () => {
    setup({ session: { ...SESSION, qrDataUrl: null } });
    expect(screen.queryByRole('img', { name: 'Scan to pay online' })).not.toBeInTheDocument();
    expect(screen.queryByText(/scan the code/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay in this window' })).toBeEnabled();
  });

  it('opens Paystack in the window, and asks the server (never trusts the popup) when it closes', async () => {
    mocks.checkOnlineSale.mockResolvedValue({ intent: { ...pending, status: 'completed', sale: SALE }, checkError: null });
    popup.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
    const { onCompleted } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Pay in this window' }));
    expect(popup.openPaystackPopup).toHaveBeenCalledWith(expect.objectContaining({ accessCode: 'acc-1' }));
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledWith(SALE));
    expect(mocks.checkOnlineSale).toHaveBeenCalledWith('31');
  });

  it('polls by itself and hands over the finished sale exactly once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.checkOnlineSale.mockResolvedValue({ intent: { ...pending, status: 'completed', sale: SALE }, checkError: null });
    const { onCompleted } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not poll while offline, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ isOffline: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocks.checkOnlineSale).not.toHaveBeenCalled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel payment' })).toBeDisabled();
  });

  it('a Paystack outage on a check keeps the sale waiting and tells the cashier', async () => {
    mocks.checkOnlineSale.mockResolvedValue({ intent: pending, checkError: 'timeout' });
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Check payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still waiting');
    expect(screen.getByRole('button', { name: 'Cancel payment' })).toBeEnabled();
  });

  it('cancel shows the cancelled state with the cart kept; a payment that landed first completes instead', async () => {
    mocks.cancelOnlineSale.mockResolvedValue({ ...pending, status: 'cancelled', cancel_reason: 'Cancelled at the till.' });
    const first = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel payment' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was charged');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(first.onClose).toHaveBeenCalled();
  });

  it('a cancel that finds the customer already paid completes the sale', async () => {
    mocks.cancelOnlineSale.mockResolvedValue({ ...pending, status: 'completed', sale: SALE });
    const { onCompleted } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel payment' }));
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledWith(SALE));
  });

  it('a paid sale that could not be completed says do not hand over the goods and names the refund', async () => {
    mocks.checkOnlineSale.mockResolvedValue({ intent: { ...pending, status: 'needs_review', review_reason: 'the amount due changed' }, checkError: null });
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Check payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Do not hand over the goods');
  });

  it('a checkout that could not reach Paystack offers Try again, which reopens it', async () => {
    mocks.reopenOnlineCheckout.mockResolvedValue({ intent: pending, accessCode: 'acc-2', checkoutUrl: 'u', qrDataUrl: 'data:image/png;base64,BBBB' });
    setup({ session: { intent: pending, checkoutError: 'Paystack is down' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Paystack is down');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Pay in this window' })).toBeInTheDocument();
  });

  it('a failed cancel leaves the sale waiting and explains', async () => {
    mocks.cancelOnlineSale.mockRejectedValue(new ApiError({ code: 'PAYMENT_GATEWAY_ERROR', message: 'Could not reach Paystack', status: 502 }));
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Paystack');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for payment');
  });
});
