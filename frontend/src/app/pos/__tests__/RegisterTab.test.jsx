import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterTab } from '../RegisterTab.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { selectWhenLoaded } from './selectWhenLoaded.js';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listTerminals: vi.fn(),
  listMenuItems: vi.fn(),
  listOrders: vi.fn(),
  openOrder: vi.fn(),
  getOrder: vi.fn(),
  addItem: vi.fn(),
  voidOrderItem: vi.fn(),
  assignItemSplitGroup: vi.fn(),
  getSettlementPreview: vi.fn(),
  settleOrder: vi.fn(),
  findInHouseForCharge: vi.fn(),
  voidOrder: vi.fn(),
  renameOrder: vi.fn(),
  startPaystackCheckout: vi.fn(),
  verifyPaystackPayment: vi.fn(),
}));

const paystackMocks = vi.hoisted(() => ({ openPaystackPopup: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

vi.mock('../../../shared/paystack.js', () => paystackMocks);

const OUTLET = { id: '1', name: 'Main Bar' };
const TERMINAL = { id: '2', device_ref: 'BAR-TERM-1' };
const MENU_ITEM = { id: '3', name: 'House Cocktail', price: '20.00', is_available: true, category: 'Drinks' };
const SOLD_OUT_ITEM = { id: '4', name: 'Rare Steak', price: '40.00', is_available: false, category: 'Mains' };

function orderItem(overrides) {
  return { id: '1', menu_item_id: '3', quantity: 1, unit_price: '20.00', modifiers: null, split_group: null, voided_at: null, ...overrides };
}

/** A real settle-response row: 20.00 subtotal + 1.50 tax + 1.50 service (7.5%) = 23.00. */
function settlementRow(overrides) {
  return { id: '1', split_group: null, method: 'cash', subtotal: '20.00', tax_amount: '1.50', tip_amount: '0.00', service_charge: '1.50', currency: 'NGN', ...overrides };
}

/** A single ×1 House Cocktail's real preview (subtotal 20.00, tax 1.50 at the ambient 7.5% VAT this session's backend tests already establish as the fixture convention). */
const SINGLE_ITEM_PREVIEW = { orderId: '9', currency: 'NGN', groups: [{ splitGroup: null, subtotal: '20.00', taxAmount: '1.50' }] };

/** "+ New tab", then accept the suggested name in the tab-name dialog. */
async function clickNewTab() {
  await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Open tab' }));
}

/** Picks the outlet and terminal, waiting for each option to load first — see `selectWhenLoaded` for the race this avoids. */
async function selectStation() {
  await selectWhenLoaded('Outlet', 'Main Bar');
  await selectWhenLoaded('Terminal', 'BAR-TERM-1');
}

/** `initialItems` seeds the FIRST `getOrder` resolution — the one `handleNewTab` itself triggers immediately after opening — so it must be queued before the "+ New tab" click, not after. */
async function openNewTab(initialItems = []) {
  const order = { id: '9', table_label: '', status: 'open' };
  render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
  await selectStation();
  mocks.openOrder.mockResolvedValue(order);
  mocks.getOrder.mockResolvedValueOnce({ order, items: initialItems, settlements: [] });
  await clickNewTab();
  await screen.findByText('Order Ticket');
  return order;
}

describe('<RegisterTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    paystackMocks.openPaystackPopup.mockReset();
    window.print = vi.fn();
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([TERMINAL]);
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM]);
    mocks.listOrders.mockResolvedValue([]);
    // The redesign fetches a real preview reactively as soon as the order
    // has items — not only behind an explicit "Settle" click, which no
    // longer exists — so every test that adds an item needs this default
    // available, whether or not it asserts on the preview's own content.
    mocks.getSettlementPreview.mockResolvedValue(SINGLE_ITEM_PREVIEW);
  });

  it('opens a new tab, adds an item by tapping its tile, and checks out by cash', async () => {
    const order = { id: '9', table_label: '', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder
      .mockResolvedValueOnce({ order, items: [], settlements: [] })
      .mockResolvedValueOnce({ order, items: [orderItem()], settlements: [] });
    mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);

    await selectStation();
    await clickNewTab();

    expect(mocks.openOrder).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', terminalId: '2', tableLabel: 'Table 1' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Add House Cocktail' }));
    expect(mocks.addItem).toHaveBeenCalledWith('9', expect.objectContaining({ menuItemId: '3', quantity: 1 }));

    expect(await screen.findByText('Subtotal')).toBeInTheDocument();
    const checkoutButton = await screen.findByRole('button', { name: 'Send to Bar & Checkout' });
    expect(checkoutButton).toBeEnabled();

    await userEvent.click(checkoutButton);
    // Service is a fixed 7.5% of the real 20.00 subtotal = 1.50, computed
    // automatically — no cashier input exists to type it.
    expect(mocks.settleOrder).toHaveBeenCalledWith('9', [expect.objectContaining({ method: 'cash', serviceCharge: '1.50' })], expect.objectContaining({}));
  });

  describe('after checkout (bug fix: checkout used to leave what looked like a blank page)', () => {
    async function checkoutWith(tender, settlementOverrides = {}) {
      const order = await openNewTab([orderItem()]);
      mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [settlementRow(settlementOverrides)] });
      await screen.findByText('Subtotal');
      await userEvent.click(screen.getByRole('button', { name: tender }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));
      return order;
    }

    it('shows a receipt with the items, the tender, and the exact total — and focuses it', async () => {
      await checkoutWith('Cash');

      const receipt = await screen.findByRole('region', { name: 'Sale receipt' });
      expect(within(receipt).getByRole('heading', { name: 'Tab settled' })).toHaveFocus();
      expect(within(receipt).getByText('House Cocktail × 1')).toBeInTheDocument();
      expect(within(receipt).getByText('Paid by Cash')).toBeInTheDocument();
      // 20.00 + 1.50 tax + 1.50 service, summed exactly.
      expect(within(receipt).getByText('Total paid').parentElement).toHaveTextContent(/23\.00/);
      expect(screen.getByRole('button', { name: 'New sale' })).toBeInTheDocument();
    });

    it('keeps the station and tab strip usable while the receipt shows — never a blank page', async () => {
      await checkoutWith('Cash');
      await screen.findByRole('region', { name: 'Sale receipt' });

      expect(screen.getByLabelText('Outlet')).toHaveValue('1');
      expect(screen.getByLabelText('Terminal')).toHaveValue('2');
      expect(screen.getByRole('button', { name: '+ New tab' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Order ticket' })).not.toBeInTheDocument();
    });

    it('names NQR on the receipt, even though it settles as method "card"', async () => {
      mocks.startPaystackCheckout.mockResolvedValue({ payment: { id: '70', status: 'CAPTURED' }, accessCode: null, checkoutError: null });
      await checkoutWith('NQR', { method: 'card', tender: 'nqr', payment_id: '70' });
      const receipt = await screen.findByRole('region', { name: 'Sale receipt' });
      expect(within(receipt).getByText('Paid by NQR')).toBeInTheDocument();
    });

    it('"New sale" opens a fresh tab, ready for the next order (bug fix: it used to leave no tab open)', async () => {
      await checkoutWith('Cash');
      const next = { id: '11', table_label: '', status: 'open' };
      mocks.openOrder.mockResolvedValue(next);
      mocks.getOrder.mockResolvedValueOnce({ order: next, items: [], settlements: [] });
      await userEvent.click(await screen.findByRole('button', { name: 'New sale' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Open tab' }));

      expect(await screen.findByRole('region', { name: 'Order ticket' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Sale receipt' })).not.toBeInTheDocument();
      expect(mocks.openOrder).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText('Terminal')).toHaveValue('2');
    });

    it('switching to another open tab from the receipt goes straight to that tab', async () => {
      const other = { id: '20', table_label: 'Table 7', status: 'open' };
      mocks.listOrders.mockResolvedValue([other]);
      await checkoutWith('Cash');
      await screen.findByRole('region', { name: 'Sale receipt' });

      mocks.getOrder.mockResolvedValueOnce({ order: other, items: [orderItem({ id: '5' })], settlements: [] });
      await userEvent.click(screen.getByRole('button', { name: 'Table 7' }));

      expect(await screen.findByRole('region', { name: 'Order ticket' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Sale receipt' })).not.toBeInTheDocument();
    });

    it('marks exactly one tender as selected (bug fix: the buttons gave no visible feedback)', async () => {
      await openNewTab([orderItem()]);
      await screen.findByText('Subtotal');
      const pressed = () => ['Cash', 'Card', 'NQR'].filter((name) => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true');

      expect(pressed()).toEqual(['Cash']);
      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      expect(pressed()).toEqual(['Card']);
      await userEvent.click(screen.getByRole('button', { name: 'NQR' }));
      expect(pressed()).toEqual(['NQR']);
    });

    it('sends exactly one settle on a double-tap, showing "Settling…" meanwhile', async () => {
      const order = await openNewTab([orderItem()]);
      let resolveSettle;
      mocks.settleOrder.mockReturnValue(new Promise((resolve) => { resolveSettle = resolve; }));
      await screen.findByText('Subtotal');

      const checkout = screen.getByRole('button', { name: 'Send to Bar & Checkout' });
      fireEvent.click(checkout);
      fireEvent.click(checkout);

      expect(mocks.settleOrder).toHaveBeenCalledTimes(1);
      const busy = await screen.findByRole('button', { name: 'Settling…' });
      expect(busy).toBeDisabled();

      await act(async () => {
        resolveSettle({ order: { ...order, status: 'settled' }, settlements: [settlementRow()] });
      });
      expect(await screen.findByRole('region', { name: 'Sale receipt' })).toBeInTheDocument();
      expect(mocks.settleOrder).toHaveBeenCalledTimes(1);
    });

    it('sends exactly one settle when the form is submitted twice in a row (e.g. Enter pressed twice), which bypasses the disabled button', async () => {
      await openNewTab([orderItem()]);
      mocks.settleOrder.mockReturnValue(new Promise(() => {}));
      await screen.findByText('Subtotal');

      const form = screen.getByRole('button', { name: 'Send to Bar & Checkout' }).closest('form');
      fireEvent.submit(form);
      fireEvent.submit(form);

      expect(mocks.settleOrder).toHaveBeenCalledTimes(1);
    });

    it('locks the station and tab strip while a checkout is in flight, so a late result can never take over another tab (code-review fix)', async () => {
      const other = { id: '20', table_label: 'Table 7', status: 'open' };
      mocks.listOrders.mockResolvedValue([other]);
      const order = await openNewTab([orderItem()]);
      let resolveSettle;
      mocks.settleOrder.mockReturnValue(new Promise((resolve) => { resolveSettle = resolve; }));
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));
      await screen.findByRole('button', { name: 'Settling…' });

      expect(screen.getByRole('button', { name: 'Table 7' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove Table 7' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '+ New tab' })).toBeDisabled();
      expect(screen.getByLabelText('Outlet')).toBeDisabled();
      expect(screen.getByLabelText('Terminal')).toBeDisabled();

      // A click attempt does nothing while locked.
      await userEvent.click(screen.getByRole('button', { name: 'Table 7' }));
      expect(mocks.getOrder).not.toHaveBeenCalledWith('20');

      await act(async () => {
        resolveSettle({ order: { ...order, status: 'settled' }, settlements: [settlementRow()] });
      });
      expect(await screen.findByRole('region', { name: 'Sale receipt' })).toBeInTheDocument();
      // Unlocked again once the checkout finishes.
      expect(screen.getByRole('button', { name: 'Table 7' })).toBeEnabled();
      expect(screen.getByLabelText('Outlet')).toBeEnabled();
    });

    it('keeps the ticket and re-enables checkout when the settle is refused', async () => {
      await openNewTab([orderItem()]);
      mocks.settleOrder.mockRejectedValue(new ApiError({ code: 'CONFLICT_POS_ORDER_NOT_OPEN', message: 'This tab was already settled on another terminal.' }));
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('This tab was already settled on another terminal.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeEnabled();
      expect(within(screen.getByRole('region', { name: 'Order ticket' })).getByText('House Cocktail')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Sale receipt' })).not.toBeInTheDocument();
    });
  });

  describe('printed receipt', () => {
    async function settleCash() {
      const order = { id: '9', table_label: 'Table 3', status: 'open' };
      render(<RegisterTab activeProperty={{ base_currency: 'NGN', name: 'Alpha Hotels', address: '1 Marina Road, Lagos' }} currentUserLabel="Ada Bello" />);
      await selectStation();
      mocks.openOrder.mockResolvedValue(order);
      mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ quantity: 2 })], settlements: [] });
      mocks.settleOrder.mockResolvedValue({
        order: { ...order, status: 'settled' },
        settlements: [settlementRow({ subtotal: '40.00', tax_amount: '3.00', service_charge: '3.00' })],
      });
      await clickNewTab();
      await screen.findByText('Subtotal');
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));
      await screen.findByRole('region', { name: 'Sale receipt' });
    }

    it('prints automatically once the sale is confirmed, and reprints on demand', async () => {
      await settleCash();
      expect(window.print).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
      expect(window.print).toHaveBeenCalledTimes(2);
    });

    it('prints the property logo at the top when one is set', async () => {
      const order = { id: '9', table_label: 'Table 3', status: 'open' };
      render(<RegisterTab activeProperty={{ base_currency: 'NGN', name: 'Alpha Hotels', logo_url: '/api/v1/media/property-logos/logo.png' }} />);
      await selectStation();
      mocks.openOrder.mockResolvedValue(order);
      mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem()], settlements: [] });
      mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [settlementRow()] });
      await clickNewTab();
      await screen.findByText('Subtotal');
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));
      await screen.findByRole('region', { name: 'Sale receipt' });

      expect(within(screen.getByTestId('printable-receipt')).getByAltText('Alpha Hotels')).toHaveAttribute('src', '/api/v1/media/property-logos/logo.png');
    });

    it('prints the property, receipt number, cashier, items, totals, and how it was paid', async () => {
      await settleCash();
      const paper = screen.getByTestId('printable-receipt');
      expect(paper).toHaveTextContent('Alpha Hotels');
      expect(paper).toHaveTextContent('1 Marina Road, Lagos');
      expect(paper).toHaveTextContent('Receipt #9');
      expect(paper).toHaveTextContent('Table 3');
      expect(paper).toHaveTextContent('Served by Ada Bello');
      expect(paper).toHaveTextContent('2 × House Cocktail');
      expect(within(paper).getByText('Subtotal').parentElement).toHaveTextContent(/40\.00/);
      expect(within(paper).getByText('Tax').parentElement).toHaveTextContent(/3\.00/);
      expect(within(paper).getByText('TOTAL').parentElement).toHaveTextContent(/46\.00/);
      expect(paper).toHaveTextContent('Cash');
    });

    it('sizes the printed page to an 80mm roll exactly as long as the receipt', async () => {
      // jsdom has no layout; pretend the receipt renders just under 100mm (377.9px) tall.
      const rect = vi.spyOn(window.Element.prototype, 'getBoundingClientRect').mockReturnValue({ height: 377.9, width: 280, top: 0, left: 0, right: 280, bottom: 377.9, x: 0, y: 0 });
      try {
        await settleCash();
        expect(document.getElementById('pos-receipt-page-size').textContent).toBe('@page receipt { size: 80mm 106mm; margin: 3mm; }');
      } finally {
        rect.mockRestore();
      }
    });

    it('keeps the sale on screen if the browser cannot print', async () => {
      window.print = vi.fn(() => {
        throw new Error('Printing blocked');
      });
      await settleCash();
      expect(screen.getByRole('region', { name: 'Sale receipt' })).toBeInTheDocument();
    });
  });

  it('shows the item photo on its menu card', async () => {
    mocks.listMenuItems.mockResolvedValue([{ ...MENU_ITEM, image_url: '/api/v1/media/menu-items/cocktail.png' }]);
    await openNewTab([]);
    const card = screen.getByRole('button', { name: 'Add House Cocktail' }).closest('div').parentElement;
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/v1/media/menu-items/cocktail.png');
  });

  describe('card and NQR through Paystack', () => {
    const PAYMENT = { id: '70', status: 'PENDING' };

    it('opens the Paystack popup, confirms the payment with the server, then settles against it', async () => {
      const order = await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({ payment: PAYMENT, accessCode: 'acc-1', checkoutError: null });
      paystackMocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
      mocks.verifyPaystackPayment.mockResolvedValue({ ...PAYMENT, status: 'CAPTURED' });
      mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [settlementRow({ method: 'card', tender: 'card', payment_id: '70' })] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      await userEvent.type(screen.getByLabelText('Customer email for receipt'), 'guest@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      const receipt = await screen.findByRole('region', { name: 'Sale receipt' });
      expect(mocks.startPaystackCheckout).toHaveBeenCalledWith('9', { splitGroup: null, tender: 'card', customerEmail: 'guest@example.com' });
      expect(paystackMocks.openPaystackPopup).toHaveBeenCalledWith(expect.objectContaining({ accessCode: 'acc-1' }));
      expect(mocks.verifyPaystackPayment).toHaveBeenCalledWith('9', '70');
      expect(mocks.settleOrder).toHaveBeenCalledWith('9', [expect.objectContaining({ method: 'card', paymentId: '70', serviceCharge: '1.50' })], expect.objectContaining({}));
      expect(within(receipt).getByText('Paid by Card')).toBeInTheDocument();
    });

    it('never settles when the popup closes without payment, and says how to retry', async () => {
      await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({ payment: PAYMENT, accessCode: 'acc-1', checkoutError: null });
      paystackMocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
      mocks.verifyPaystackPayment.mockResolvedValue(PAYMENT);
      mocks.getOrder.mockResolvedValue({ order: { id: '9', table_label: '', status: 'open' }, items: [orderItem()], settlements: [], registerPayments: [PAYMENT] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'NQR' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('The NQR payment was not completed. Tap checkout again to reopen it.')).toBeInTheDocument();
      expect(mocks.startPaystackCheckout).toHaveBeenCalledWith('9', expect.objectContaining({ tender: 'nqr' }));
      expect(mocks.settleOrder).not.toHaveBeenCalled();
      expect(await screen.findByRole('button', { name: 'Send to Bar & Checkout' })).toBeEnabled();
    });

    it('reports a failed payment distinctly', async () => {
      await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({ payment: PAYMENT, accessCode: 'acc-1', checkoutError: null });
      paystackMocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
      mocks.verifyPaystackPayment.mockResolvedValue({ ...PAYMENT, status: 'FAILED' });
      mocks.getOrder.mockResolvedValue({ order: { id: '9', table_label: '', status: 'open' }, items: [orderItem()], settlements: [] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('The Card payment failed. Try again or choose another way to pay.')).toBeInTheDocument();
      expect(mocks.settleOrder).not.toHaveBeenCalled();
    });

    it('shows the gateway error when Paystack checkout cannot start', async () => {
      await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({ payment: { id: '70', status: 'INITIATED' }, accessCode: null, checkoutError: 'Paystack unreachable' });
      mocks.getOrder.mockResolvedValue({ order: { id: '9', table_label: '', status: 'open' }, items: [orderItem()], settlements: [] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('Could not open Paystack: Paystack unreachable')).toBeInTheDocument();
      expect(paystackMocks.openPaystackPopup).not.toHaveBeenCalled();
      expect(mocks.settleOrder).not.toHaveBeenCalled();
    });

    it('explains when the Paystack account has the tender switched off', async () => {
      await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({
        payment: { id: '70', status: 'INITIATED' },
        accessCode: null,
        checkoutError: 'The "paystack" gateway returned an error: No active channel to process transaction. Please contact merchant',
      });
      mocks.getOrder.mockResolvedValue({ order: { id: '9', table_label: '', status: 'open' }, items: [orderItem()], settlements: [] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'NQR' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText(/NQR payments are not enabled on this Paystack account yet/)).toBeInTheDocument();
      expect(mocks.settleOrder).not.toHaveBeenCalled();
    });

    it('settles straight away with a payment the server already captured, without a second popup', async () => {
      const order = await openNewTab([orderItem()]);
      mocks.startPaystackCheckout.mockResolvedValue({ payment: { id: '70', status: 'CAPTURED' }, accessCode: null, checkoutError: null });
      mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [settlementRow({ method: 'card', tender: 'card', payment_id: '70' })] });
      await screen.findByText('Subtotal');

      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      await screen.findByRole('region', { name: 'Sale receipt' });
      expect(paystackMocks.openPaystackPopup).not.toHaveBeenCalled();
      expect(mocks.settleOrder).toHaveBeenCalledWith('9', [expect.objectContaining({ paymentId: '70' })], expect.objectContaining({}));
    });

    it('tells the cashier when a tab already holds a captured payment', async () => {
      await openNewTab([orderItem()]);
      mocks.getOrder.mockResolvedValueOnce({
        order: { id: '9', table_label: '', status: 'open' },
        items: [orderItem()],
        settlements: [],
        registerPayments: [{ id: '70', status: 'CAPTURED' }],
      });
      mocks.addItem.mockResolvedValue({});
      await userEvent.click(screen.getByRole('button', { name: 'Add another House Cocktail' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Payment already received for this tab');
    });
  });

  describe('removing a tab', () => {
    const TABLE_1 = { id: '9', table_label: 'Table 1', status: 'open' };
    const TABLE_2 = { id: '10', table_label: 'Table 2', status: 'open' };

    async function renderWithTabs() {
      mocks.listOrders.mockResolvedValue([TABLE_1, TABLE_2]);
      render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
      await selectStation();
      await screen.findByRole('button', { name: 'Table 2' });
    }

    it('closes an empty tab immediately — voided with a recorded reason, no confirmation needed', async () => {
      await renderWithTabs();
      mocks.getOrder.mockResolvedValueOnce({ order: TABLE_2, items: [], settlements: [] });
      mocks.voidOrder.mockResolvedValue({ ...TABLE_2, status: 'void' });

      await userEvent.click(screen.getByRole('button', { name: 'Remove Table 2' }));

      expect(mocks.voidOrder).toHaveBeenCalledExactlyOnceWith('10', 'Empty tab removed from the Register');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Table 2' })).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Table 1' })).toBeInTheDocument();
      expect(screen.queryByText('Remove tab')).not.toBeInTheDocument();
    });

    it('asks for confirmation and a reason before voiding a tab that still has items', async () => {
      await renderWithTabs();
      mocks.getOrder.mockResolvedValueOnce({ order: TABLE_1, items: [orderItem({ id: '1' }), orderItem({ id: '2', voided_at: '2026-09-13T08:00:00Z' })], settlements: [] });
      mocks.voidOrder.mockResolvedValue({ ...TABLE_1, status: 'void' });

      await userEvent.click(screen.getByRole('button', { name: 'Remove Table 1' }));

      // Only the unvoided item counts.
      expect(await screen.findByText(/"Table 1" still has 1 item on it/)).toBeInTheDocument();
      const confirmButton = screen.getByRole('button', { name: 'Remove tab' });
      expect(confirmButton).toBeDisabled();
      expect(mocks.voidOrder).not.toHaveBeenCalled();

      await userEvent.type(screen.getByLabelText('Reason'), 'Guest walked out before ordering more');
      await userEvent.click(confirmButton);

      expect(mocks.voidOrder).toHaveBeenCalledExactlyOnceWith('9', 'Guest walked out before ordering more');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Table 1' })).not.toBeInTheDocument());
    });

    it('keeps the tab when the confirmation is cancelled', async () => {
      await renderWithTabs();
      mocks.getOrder.mockResolvedValueOnce({ order: TABLE_1, items: [orderItem()], settlements: [] });

      await userEvent.click(screen.getByRole('button', { name: 'Remove Table 1' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(mocks.voidOrder).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Table 1' })).toBeInTheDocument();
    });

    it('clears the order panel when the tab being removed is the one currently open', async () => {
      const order = await openNewTab([orderItem()]);
      mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem()], settlements: [] });
      mocks.voidOrder.mockResolvedValue({ ...order, status: 'void' });

      await userEvent.click(screen.getByRole('button', { name: `Remove Tab #${order.id}` }));
      await userEvent.type(await screen.findByLabelText('Reason'), 'Opened by mistake');
      await userEvent.click(screen.getByRole('button', { name: 'Remove tab' }));

      await waitFor(() => expect(screen.queryByText('Order Ticket')).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: `Tab #${order.id}` })).not.toBeInTheDocument();
    });

    it('shows the real error and keeps the tab when the void is refused', async () => {
      await renderWithTabs();
      mocks.getOrder.mockResolvedValueOnce({ order: TABLE_2, items: [], settlements: [] });
      mocks.voidOrder.mockRejectedValue(new ApiError({ code: 'CONFLICT_POS_ORDER_NOT_OPEN', message: 'This tab was already settled on another terminal.' }));

      await userEvent.click(screen.getByRole('button', { name: 'Remove Table 2' }));

      expect(await screen.findByText('This tab was already settled on another terminal.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Table 2' })).toBeInTheDocument();
    });
  });

  it('asks for a tab name, and opens the tab under the name the cashier typed', async () => {
    const order = { id: '9', table_label: 'Pool bar – John', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder.mockResolvedValue({ order, items: [], settlements: [] });
    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectStation();

    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
    const dialog = await screen.findByRole('dialog', { name: 'Name this tab' });
    const input = within(dialog).getByLabelText('Tab name');
    expect(input).toHaveValue('Table 1');
    await userEvent.clear(input);
    await userEvent.type(input, 'Pool bar – John');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open tab' }));

    expect(mocks.openOrder).toHaveBeenCalledWith(expect.objectContaining({ tableLabel: 'Pool bar – John' }));
    expect(await screen.findByRole('button', { name: 'Pool bar – John' })).toBeInTheDocument();
  });

  it('cancelling the name dialog opens no tab', async () => {
    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectStation();
    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Name this tab' })).getByRole('button', { name: 'Cancel' }));
    expect(mocks.openOrder).not.toHaveBeenCalled();
  });

  it('renames the open tab from the ticket header', async () => {
    const order = await openNewTab([]);
    mocks.renameOrder.mockResolvedValue({ ...order, table_label: 'Room 205' });
    await userEvent.click(screen.getByRole('button', { name: /^Rename / }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename tab' });
    const input = within(dialog).getByLabelText('Tab name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Room 205');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));

    expect(mocks.renameOrder).toHaveBeenCalledWith('9', 'Room 205');
    expect(await screen.findByRole('button', { name: 'Room 205' })).toBeInTheDocument();
  });

  it('reference-design fix: a second new tab is auto-labelled "Table 2", not left blank', async () => {
    mocks.listOrders.mockResolvedValue([{ id: '9', table_label: 'Table 1', status: 'open' }]);
    mocks.openOrder.mockResolvedValue({ id: '10', table_label: 'Table 2', status: 'open' });
    mocks.getOrder.mockResolvedValue({ order: { id: '10', table_label: 'Table 2', status: 'open' }, items: [], settlements: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectStation();
    await screen.findByRole('button', { name: 'Table 1' }); // the pre-existing open tab

    await clickNewTab();
    expect(mocks.openOrder).toHaveBeenCalledWith(expect.objectContaining({ tableLabel: 'Table 2' }));
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    const order = { id: '9', table_label: '', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder.mockResolvedValue({ order, items: [], settlements: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'KES' }} />);
    await selectStation();
    await clickNewTab();

    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output, not assumed) — proves the currency
    // actually threaded through, not just that the component happened to
    // still say "NGN".
    expect(await screen.findByText(/Ksh/)).toBeInTheDocument();
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('groups repeated taps on the same item into one ticket line, and the stepper "+" adds another', async () => {
    const order = await openNewTab();
    mocks.getOrder
      .mockResolvedValueOnce({ order, items: [orderItem({ id: '1' })], settlements: [] })
      .mockResolvedValueOnce({ order, items: [orderItem({ id: '1' }), orderItem({ id: '2' })], settlements: [] });

    await userEvent.click(screen.getByRole('button', { name: 'Add House Cocktail' }));
    expect(await screen.findByRole('button', { name: 'Remove one House Cocktail' })).toBeInTheDocument();
    const ticket = screen.getByRole('region', { name: 'Order ticket' });
    // One merged line, not two — the ticket only ever shows one "House
    // Cocktail" name regardless of how many units are on it (the menu grid
    // also legitimately shows the same name, hence scoping to the ticket).
    expect(within(ticket).getAllByText('House Cocktail')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add another House Cocktail' }));
    expect(mocks.addItem).toHaveBeenLastCalledWith('9', expect.objectContaining({ menuItemId: '3' }));
    expect(await within(ticket).findByText('2')).toBeInTheDocument(); // the stepper's own live quantity
    expect(within(ticket).getAllByText('House Cocktail')).toHaveLength(1);
  });

  it('the "−" stepper voids only the most recently added unit through a real ConfirmDialog, requiring a reason', async () => {
    const order = await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ id: '1' })], settlements: [] });
    const ticket = await screen.findByRole('region', { name: 'Order ticket' });

    await within(ticket).findByText('2');
    await userEvent.click(screen.getByRole('button', { name: 'Remove one House Cocktail' }));

    expect(screen.getByText('Void item')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Void' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Guest changed their mind');
    await userEvent.click(confirmButton);

    // The LAST-added row only (id "2"), not the whole line.
    expect(mocks.voidOrderItem).toHaveBeenCalledExactlyOnceWith('9', '2', 'Guest changed their mind');
    expect(await within(ticket).findByText('1')).toBeInTheDocument();
  });

  it('the trash icon voids the WHOLE line (every unit) in one action, distinct from the "−" stepper', async () => {
    const order = await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    mocks.getOrder.mockResolvedValueOnce({ order, items: [], settlements: [] });
    const ticket = await screen.findByRole('region', { name: 'Order ticket' });

    await within(ticket).findByText('2');
    await userEvent.click(screen.getByRole('button', { name: 'Void House Cocktail' }));

    expect(screen.getByText('Void item')).toBeInTheDocument();
    expect(screen.getByText(/This removes all 2 "House Cocktail"/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Reason'), 'Wrong table');
    await userEvent.click(screen.getByRole('button', { name: 'Void' }));

    // Both rows, not just the last one.
    expect(mocks.voidOrderItem).toHaveBeenCalledWith('9', '1', 'Wrong table');
    expect(mocks.voidOrderItem).toHaveBeenCalledWith('9', '2', 'Wrong table');
    expect(await within(ticket).findByText('Tap a menu item to add it to this ticket.')).toBeInTheDocument();
  });

  it('bug fix: a whole-line void where ONE of several rows genuinely fails still reloads the real state and surfaces the error, never leaving the ticket stale', async () => {
    const order = await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    // Row "1" already voided by a concurrent terminal — a real, reachable
    // partial failure, not a contrived one.
    mocks.voidOrderItem.mockImplementation((_orderId, id) =>
      id === '1' ? Promise.reject(new ApiError({ code: 'BUSINESS_RULE_ALREADY_VOIDED', message: 'Already voided.' })) : Promise.resolve({})
    );
    // The reload after this partial failure reflects reality: row "1" was
    // already gone, row "2" is now gone too — an empty ticket.
    mocks.getOrder.mockResolvedValueOnce({ order, items: [], settlements: [] });
    const ticket = await screen.findByRole('region', { name: 'Order ticket' });

    await within(ticket).findByText('2');
    await userEvent.click(screen.getByRole('button', { name: 'Void House Cocktail' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'Cleanup');
    await userEvent.click(screen.getByRole('button', { name: 'Void' }));

    // The real error surfaces...
    expect(await screen.findByText('Already voided.')).toBeInTheDocument();
    // ...but the ticket is still reloaded to reflect true server state,
    // never left showing the stale pre-void ×2 line.
    expect(await within(ticket).findByText('Tap a menu item to add it to this ticket.')).toBeInTheDocument();
  });

  it('shows a sold-out item visibly, disabled, rather than hiding it', async () => {
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM, SOLD_OUT_ITEM]);
    await openNewTab();

    const soldOutTile = screen.getByRole('button', { name: 'Add Rare Steak' });
    expect(soldOutTile).toBeDisabled();
    expect(screen.getByText('Sold out')).toBeInTheDocument();

    await userEvent.click(soldOutTile);
    expect(mocks.addItem).not.toHaveBeenCalled();
  });

  it('filters the menu by category rail and by search text', async () => {
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM, SOLD_OUT_ITEM]);
    await openNewTab();

    expect(screen.getByText('House Cocktail')).toBeInTheDocument();
    expect(screen.getByText('Rare Steak')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mains' }));
    expect(screen.queryByText('House Cocktail')).not.toBeInTheDocument();
    expect(screen.getByText('Rare Steak')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByLabelText('Search the menu'), 'cocktail');
    expect(screen.getByText('House Cocktail')).toBeInTheDocument();
    expect(screen.queryByText('Rare Steak')).not.toBeInTheDocument();
  });

  it('layout pass: the checkout panel shows a real subtotal/tax/service (fixed 7.5%, no tip or editable %) and submits the computed amount', async () => {
    const order = await openNewTab([orderItem()]);
    mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [] });

    expect(await screen.findByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('Service (7.5%)')).toBeInTheDocument();
    expect(screen.getAllByText(/20\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.50/).length).toBeGreaterThan(0); // tax AND service both land on 1.50 here — same 7.5% rate, same 20.00 subtotal

    // No Tip input, no editable Service % input — the fixed rate applies
    // automatically with no cashier interaction at all.
    expect(screen.queryByLabelText('Tip')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service %')).not.toBeInTheDocument();

    // Total = 20.00 subtotal + 1.50 tax + 1.50 service (7.5% of 20.00) = 23.00.
    expect(await screen.findByText(/23\.00/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));
    expect(mocks.settleOrder).toHaveBeenCalledWith(
      '9',
      expect.arrayContaining([expect.objectContaining({ method: 'cash', serviceCharge: '1.50' })]),
      expect.objectContaining({})
    );
  });

  it('bug fix: shows "Calculating…" and disables checkout until the real, tax-inclusive preview resolves', async () => {
    let resolvePreview;
    mocks.getSettlementPreview.mockReturnValueOnce(new Promise((resolve) => { resolvePreview = resolve; }));
    await openNewTab([orderItem()]);

    expect(screen.getByText('Calculating subtotal and tax…')).toBeInTheDocument();
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeDisabled();

    await act(async () => {
      resolvePreview(SINGLE_ITEM_PREVIEW);
      await Promise.resolve();
    });

    expect(await screen.findByText('Subtotal')).toBeInTheDocument();
    expect(screen.queryByText('Calculating subtotal and tax…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeEnabled();
  });

  it('bug fix: a failed settlement preview shows a real error with a working Retry, and checkout stays disabled', async () => {
    mocks.getSettlementPreview.mockRejectedValueOnce(new Error('boom'));
    await openNewTab([orderItem()]);

    expect(await screen.findByText('Could not compute the real settlement total.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeDisabled();
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();

    mocks.getSettlementPreview.mockResolvedValueOnce(SINGLE_ITEM_PREVIEW);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeEnabled();
  });

  it('code-review fix: an empty preview response (every item voided by a concurrent terminal) keeps checkout disabled', async () => {
    mocks.getSettlementPreview.mockResolvedValueOnce({ orderId: '9', currency: 'NGN', groups: [] });
    await openNewTab([orderItem()]);

    // `[]` is a real, non-null response — the fix is checking every
    // displayed group has an actual match, not merely "a response arrived".
    await screen.findByRole('button', { name: 'Cash' });
    expect(screen.getByText('Calculating subtotal and tax…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeDisabled();
  });

  it('code-review fix: a stale preview response from an earlier item change is discarded, never overwriting a later one', async () => {
    let resolveFirst;
    mocks.getSettlementPreview.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const order = await openNewTab();

    // Adding the FIRST item starts a slow preview fetch.
    mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ id: '1' })], settlements: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Add House Cocktail' }));
    expect(await screen.findByText('Calculating subtotal and tax…')).toBeInTheDocument();

    // Before it resolves, adding a SECOND item starts a faster fetch that
    // resolves first, with the real, current totals.
    mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ id: '1' }), orderItem({ id: '2' })], settlements: [] });
    mocks.getSettlementPreview.mockResolvedValueOnce({ orderId: '9', currency: 'NGN', groups: [{ splitGroup: null, subtotal: '40.00', taxAmount: '3.00' }] });
    await userEvent.click(screen.getByRole('button', { name: 'Add another House Cocktail' }));
    expect(await screen.findByText('Subtotal')).toBeInTheDocument();
    expect(screen.getAllByText(/40\.00/).length).toBeGreaterThan(0);

    // The FIRST, now-stale fetch (for one item only) finally resolves —
    // it must never overwrite the real, current two-item totals.
    await act(async () => {
      resolveFirst(SINGLE_ITEM_PREVIEW);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByText(/^20\.00$/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/40\.00/).length).toBeGreaterThan(0);
  });

  it('searches for an in-house guest when charging to room, and the guest picker is required', async () => {
    await openNewTab([orderItem()]);
    mocks.findInHouseForCharge.mockResolvedValue([{ reservationId: '55', roomNumber: '204', guestFirstName: 'Ada', guestLastName: 'Bello' }]);
    await screen.findByText('Subtotal');

    await userEvent.click(screen.getByRole('button', { name: 'Charge to room instead' }));
    expect(screen.getByDisplayValue('Select guest')).toBeRequired();

    await userEvent.type(screen.getByPlaceholderText('Room number or guest name'), '204');
    expect(mocks.findInHouseForCharge).toHaveBeenCalledWith('204');
    expect(await screen.findByText(/Room 204 — Ada Bello/)).toBeInTheDocument();
  });

  it('bug fix: a slow guest search left in flight on one tab never populates a DIFFERENT tab\'s guest picker after switching', async () => {
    const orderA = { id: '9', table_label: 'Table 1', status: 'open' };
    const orderB = { id: '10', table_label: 'Table 2', status: 'open' };
    mocks.listOrders.mockResolvedValue([orderA, orderB]);
    mocks.getSettlementPreview.mockResolvedValue({ orderId: '9', currency: 'NGN', groups: [{ splitGroup: null, subtotal: '20.00', taxAmount: '1.50' }] });

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectStation();

    // Tab A: start a slow, deliberately never-resolved-yet guest search.
    mocks.getOrder.mockResolvedValueOnce({ order: orderA, items: [orderItem({ id: '1' })], settlements: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Table 1' }));
    await screen.findByText('Subtotal');
    await userEvent.click(screen.getByRole('button', { name: 'Charge to room instead' }));
    // A single `fireEvent.change` (not `userEvent.type`, which fires once per
    // keystroke) — typing "204" character by character would call
    // `handleGuestSearch` three times, and the later, faster-resolving "20"/
    // "204" calls would supersede this deferred "204" search's own requestId
    // long before the tab switch below ever happens, via the *same-tab*
    // monotonic-counter guard alone — masking the cross-tab `.clear()`
    // mechanism this test exists to prove, exactly the gap a prior mutation
    // test found: the fix's own `.clear()` call could be deleted entirely
    // and this test still passed, for the wrong reason.
    let resolveSearch;
    mocks.findInHouseForCharge.mockReturnValueOnce(new Promise((resolve) => { resolveSearch = resolve; }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Room number or guest name'), { target: { value: '204' } });
    });

    // Switch to tab B before that search resolves — a real, different
    // order, unsplit (same "null" group key A's own search was keyed by)
    // — and also select "Charge to room" on B, so B's own guest picker is
    // genuinely mounted and checkable (not merely absent because B never
    // opened that subform at all, which would make this assertion trivially
    // true regardless of whether the leak fix works).
    mocks.getOrder.mockResolvedValueOnce({ order: orderB, items: [orderItem({ id: '2' })], settlements: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Table 2' }));
    await screen.findByText('Subtotal');
    await userEvent.click(screen.getByRole('button', { name: 'Charge to room instead' }));
    expect(screen.getByDisplayValue('Select guest')).toBeInTheDocument(); // B's own picker, genuinely empty so far

    // A's stale search finally resolves — it must never land on B's form.
    await act(async () => {
      resolveSearch([{ reservationId: '55', roomNumber: '204', guestFirstName: 'Ada', guestLastName: 'Bello' }]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.queryByText(/Room 204 — Ada Bello/)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Select guest')).toBeInTheDocument();
  });

  it('confirmed design fork: split billing is reachable via a "Split bill" action, restyled into the same panel, not dropped', async () => {
    const order = await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    await screen.findByText('Subtotal');

    await userEvent.click(screen.getByRole('button', { name: 'Split bill' }));
    expect(screen.getByText('Split this tab')).toBeInTheDocument();

    // Assigning the first item to Group 1 creates a second, distinct
    // settlement group — the exact backend contract `settleOrder` already
    // requires (cover every distinct group in one call).
    mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ id: '1', split_group: 1 }), orderItem({ id: '2' })], settlements: [] });
    mocks.getSettlementPreview.mockResolvedValueOnce({
      orderId: '9',
      currency: 'NGN',
      groups: [
        { splitGroup: null, subtotal: '20.00', taxAmount: '1.50' },
        { splitGroup: 1, subtotal: '20.00', taxAmount: '1.50' },
      ],
    });
    const modal = screen.getByText('Split this tab').closest('form');
    const [firstItemSelect] = within(modal).getAllByRole('combobox');
    await userEvent.selectOptions(firstItemSelect, '1');
    expect(mocks.assignItemSplitGroup).toHaveBeenCalledWith('9', '1', 1);

    expect(await within(modal).findByText('Ungrouped')).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: 'Group 1' })).toBeInTheDocument();

    mocks.settleOrder.mockResolvedValue({
      order: { ...order, status: 'settled' },
      settlements: [settlementRow({ id: '1', split_group: null }), settlementRow({ id: '2', split_group: 1 })],
    });
    await userEvent.click(within(modal).getByRole('button', { name: 'Confirm settlement' }));
    expect(mocks.settleOrder).toHaveBeenCalledWith(
      '9',
      expect.arrayContaining([expect.objectContaining({ splitGroup: null }), expect.objectContaining({ splitGroup: 1 })]),
      expect.objectContaining({})
    );

    // The receipt lists one line per check, and the combined total.
    const receipt = await screen.findByRole('region', { name: 'Sale receipt' });
    expect(within(receipt).getByText('Ungrouped · Paid by Cash')).toBeInTheDocument();
    expect(within(receipt).getByText('Group 1 · Paid by Cash')).toBeInTheDocument();
    expect(within(receipt).getByText('Total paid').parentElement).toHaveTextContent(/46\.00/);
  });

  it('bug fix: opening "Split bill" before any item has a real group hides the inline checkout underneath, never a second live copy', async () => {
    await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    await screen.findByText('Subtotal');
    expect(screen.getByRole('button', { name: 'Send to Bar & Checkout' })).toBeInTheDocument();

    // At this point no item has a real split_group yet — anySplit is still
    // false — the exact, always-reproducible case this fix closes.
    await userEvent.click(screen.getByRole('button', { name: 'Split bill' }));

    expect(screen.getByText('Split this tab')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Bar & Checkout' })).not.toBeInTheDocument();
  });

  it('bug fix: a stale, out-of-order loadActiveOrder response for a PREVIOUS tab never clobbers a correctly-loaded, currently active tab', async () => {
    const orderA = { id: '9', table_label: 'Tab A', status: 'open' };
    const orderB = { id: '10', table_label: 'Tab B', status: 'open' };
    mocks.listOrders.mockResolvedValue([orderA, orderB]);
    mocks.getSettlementPreview.mockResolvedValue({ orderId: '9', currency: 'NGN', groups: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await selectStation();

    // Open tab A first — a real, already-correct load.
    mocks.getOrder.mockResolvedValueOnce({ order: orderA, items: [orderItem({ id: '1' })], settlements: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Tab A' }));
    await screen.findByText('Order Ticket');

    // Adding an item to tab A starts a SLOW reload, deliberately never
    // resolved in this test until the very end.
    let resolveStaleReload;
    mocks.getOrder.mockReturnValueOnce(new Promise((resolve) => { resolveStaleReload = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: 'Add House Cocktail' }));

    // Before that resolves, the cashier switches to tab B — a real,
    // FASTER load that correctly resolves first.
    mocks.getOrder.mockResolvedValueOnce({ order: orderB, items: [orderItem({ id: '2', menu_item_id: '3' })], settlements: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Tab B' }));
    const ticket = await screen.findByRole('region', { name: 'Order ticket' });
    await within(ticket).findByText('House Cocktail');

    // The stale reload for tab A (no longer active) finally resolves —
    // it must never clobber tab B's own, already-correct, currently
    // displayed data.
    await act(async () => {
      resolveStaleReload({ order: orderA, items: [orderItem({ id: '1' }), orderItem({ id: '3' })], settlements: [] });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(within(ticket).getByText('House Cocktail')).toBeInTheDocument();
    expect(screen.queryByText('Tap a menu item to add it to this ticket.')).not.toBeInTheDocument();
  });

  it('once real split groups exist, the main ticket panel shows a split summary instead of a single inline checkout', async () => {
    await openNewTab([orderItem({ id: '1', split_group: 1 }), orderItem({ id: '2', split_group: 2 })]);

    expect(await screen.findByText('This tab is split into 2 checks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Bar & Checkout' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage split & checkout' })).toBeInTheDocument();
  });

  describe('gap closure: the stock-out override guard', () => {
    function stockRejection(items) {
      return new ApiError({ code: 'BUSINESS_RULE_INSUFFICIENT_STOCK', message: 'Insufficient stock.', details: { items } });
    }

    it('adding an item that would deplete stock shows a dedicated prompt naming the item — not the generic error banner — then resubmits with the reason once confirmed', async () => {
      const order = await openNewTab([]);
      mocks.addItem.mockRejectedValueOnce(stockRejection([{ name: 'Garnish Lime', unit: 'ml', projectedQuantity: '0.000' }]));

      await userEvent.click(screen.getByRole('button', { name: 'Add House Cocktail' }));

      expect(await screen.findByText('Low stock')).toBeInTheDocument();
      expect(screen.getByText(/Garnish Lime would run out/)).toBeInTheDocument();
      // Never the generic error banner for this specific rejection.
      expect(screen.queryByText('Insufficient stock.')).not.toBeInTheDocument();

      mocks.addItem.mockResolvedValueOnce({});
      mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem()], settlements: [] });
      await userEvent.type(screen.getByLabelText('Reason'), 'Confirmed with the bar, count is off');
      await userEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));

      expect(mocks.addItem).toHaveBeenLastCalledWith(
        '9',
        expect.objectContaining({ menuItemId: '3', quantity: 1, stockOverrideReason: 'Confirmed with the bar, count is off' })
      );
      expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
    });

    it('cancelling the low-stock prompt never resubmits the add', async () => {
      await openNewTab([]);
      mocks.addItem.mockRejectedValueOnce(stockRejection([{ name: 'Garnish Lime' }]));

      await userEvent.click(screen.getByRole('button', { name: 'Add House Cocktail' }));
      await screen.findByText('Low stock');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
      expect(mocks.addItem).toHaveBeenCalledTimes(1);
    });

    it('settling a cash tab that would deplete stock shows the same prompt and resubmits settleOrder alone with the reason, once confirmed', async () => {
      const order = await openNewTab([orderItem()]);
      await screen.findByText('Subtotal');
      mocks.settleOrder.mockRejectedValueOnce(stockRejection([{ name: 'House Cocktail\'s own garnish' }]));

      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('Low stock')).toBeInTheDocument();

      mocks.settleOrder.mockResolvedValueOnce({ order: { ...order, status: 'settled' }, settlements: [settlementRow()] });
      await userEvent.type(screen.getByLabelText('Reason'), 'Last of this batch');
      await userEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));

      expect(mocks.settleOrder).toHaveBeenLastCalledWith(
        '9',
        [expect.objectContaining({ method: 'cash' })],
        expect.objectContaining({ stockOverrideReason: 'Last of this batch' })
      );
      await screen.findByRole('region', { name: 'Sale receipt' });
    });

    it('a card payment already captured before a stock rejection is never re-collected on the override retry', async () => {
      const order = await openNewTab([orderItem()]);
      await screen.findByText('Subtotal');
      const PAYMENT = { id: '70', status: 'PENDING' };
      mocks.startPaystackCheckout.mockResolvedValue({ payment: PAYMENT, accessCode: 'acc-1', checkoutError: null });
      mocks.verifyPaystackPayment.mockResolvedValue({ id: '70', status: 'CAPTURED' });
      paystackMocks.openPaystackPopup.mockImplementation(async ({ onClose }) => onClose());
      mocks.settleOrder.mockRejectedValueOnce(stockRejection([{ name: 'Garnish Lime' }]));

      await userEvent.click(screen.getByRole('button', { name: 'Card' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send to Bar & Checkout' }));

      expect(await screen.findByText('Low stock')).toBeInTheDocument();
      // The Paystack popup ran exactly once — the retry below must not open it again.
      expect(paystackMocks.openPaystackPopup).toHaveBeenCalledTimes(1);

      mocks.settleOrder.mockResolvedValueOnce({ order: { ...order, status: 'settled' }, settlements: [settlementRow({ method: 'card', payment_id: '70' })] });
      await userEvent.type(screen.getByLabelText('Reason'), 'Confirmed');
      await userEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));

      expect(paystackMocks.openPaystackPopup).toHaveBeenCalledTimes(1); // Still once — no second popup.
      expect(mocks.settleOrder).toHaveBeenLastCalledWith(
        '9',
        [expect.objectContaining({ method: 'card', paymentId: '70' })],
        expect.objectContaining({ stockOverrideReason: 'Confirmed' })
      );
      await screen.findByRole('region', { name: 'Sale receipt' });
    });
  });
});
