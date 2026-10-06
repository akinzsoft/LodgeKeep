import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { approveInDialog, TEST_APPROVERS, TEST_APPROVAL_TOKEN } from '../../approvals/__tests__/approveInDialog.js';
import { SupermarketScreen } from '../SupermarketScreen.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listMyOutlets: vi.fn(),
  lookupBarcode: vi.fn(),
  searchItems: vi.fn(),
  createSale: vi.fn(),
  getSale: vi.fn(),
  listSales: vi.fn(),
  voidSale: vi.fn(),
  getLowStock: vi.fn(),
  listMySales: vi.fn(),
  getSalesTotals: vi.fn(),
  getMySalesTotals: vi.fn(),
  getSetupFlags: vi.fn(),
  addBarcode: vi.fn(),
  listBarcodes: vi.fn(),
  listProducts: vi.fn(),
  updateProduct: vi.fn(),
  archiveProduct: vi.fn(),
  restoreProduct: vi.fn(),
  removeBarcode: vi.fn(),
  getStockOnHand: vi.fn(),
  listProductsImports: vi.fn(),
  startOnlineSale: vi.fn(),
  getPendingOnlineSale: vi.fn(),
  reopenOnlineCheckout: vi.fn(),
  checkOnlineSale: vi.fn(),
  cancelOnlineSale: vi.fn(),
  listOnlineSalesNeedingReview: vi.fn(),
  refundOnlineSale: vi.fn(),
}));

const posMocks = vi.hoisted(() => ({
  listMenuItems: vi.fn(),
  listMenuCategories: vi.fn(),
}));

// No camera in jsdom: the scanner plumbing is stubbed (cameraSupported false unless a test says otherwise).
const scanner = vi.hoisted(() => ({
  describeCamera: vi.fn(() => null),
  decoderInfo: vi.fn(() => ({ state: 'ready', loadMs: 1, wasmUrl: '/assets/x.wasm', error: null })),
  listCameras: vi.fn(async () => []),
  lastFrame: vi.fn(() => null),
  cameraSupported: vi.fn(() => false),
  openCamera: vi.fn(),
  closeCamera: vi.fn(),
  loadDetector: vi.fn(),
  readFrame: vi.fn(),
  torchSupported: vi.fn(() => false),
  setTorch: vi.fn(),
  newScanStats: () => ({ notReady: 0, attempts: 0, completed: 0, empty: 0, errors: 0, lastError: null, lastMs: null, lastCode: null, frameSize: null, inFlightSince: null }),
}));
vi.mock('../../../shared/scanner/cameraScanner.js', () => scanner);
vi.mock('../../pos/StockWastageTab.jsx', () => ({
  StockWastageTab: ({ lockedOutlet }) => <div data-testid="stock-wastage">wastage at {lockedOutlet.name}</div>,
}));
vi.mock('../../pos/StockRequestsTab.jsx', () => ({
  StockRequestsTab: ({ deliverToOutletId }) => <div data-testid="stock-requests">requests for {deliverToOutletId}</div>,
}));
vi.mock('../../../shared/sound/alertBeep.js', () => ({ playScanTone: vi.fn(), playAlertBeep: vi.fn(), unlockAlertSound: vi.fn() }));
// A void, a needs-review refund or a confirmed oversell needs a manager's PIN approval (ManagerApprovalDialog).
const approvalMocks = vi.hoisted(() => ({ listApprovers: vi.fn(), requestApproval: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: mocks, posApi: posMocks, approvalsApi: approvalMocks };
});

const PROPERTY = { name: 'Alpha Hotels', base_currency: 'NGN' };
const SELLER = new Set(['supermarket.sales']);
const REPORT_ONLY = new Set(['supermarket.report']);
const MANAGER = new Set(['supermarket.sales', 'supermarket.report', 'supermarket.manage']);

const RICE = { id: '11', name: 'Rice 5kg', price: '107.50' };
const SOAP = { id: '12', name: 'Soap', price: '10.00' };
const notFound = () => new ApiError({ code: 'VALIDATION_BARCODE_NOT_FOUND', message: 'No product has the barcode', status: 404 });

const SALE = {
  id: '90',
  receipt_number: 7,
  receipt_code: 'MART-000007',
  outlet_name: 'Mini Mart',
  method: 'cash',
  subtotal: '125.00',
  tax_amount: '9.38',
  total: '134.38',
  currency: 'NGN',
  created_at: '2027-09-01T10:00:00',
  voided_at: null,
  lines: [{ id: '1', line_no: 1, item_name: 'Rice 5kg', quantity: 1, unit_price: '107.50', line_total: '107.50' }],
};

describe('<SupermarketScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(posMocks).forEach((fn) => fn.mockReset());
    approvalMocks.listApprovers.mockResolvedValue(TEST_APPROVERS);
    approvalMocks.requestApproval.mockResolvedValue({ token: TEST_APPROVAL_TOKEN });
    // By default the full-menu call fails, so these tests exercise the scan/search fallback.
    posMocks.listMenuItems.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'no', status: 403 }));
    posMocks.listMenuCategories.mockResolvedValue([]);
    mocks.listMyOutlets.mockResolvedValue([{ id: '5', name: 'Mini Mart' }]);
    mocks.listSales.mockResolvedValue([]);
    mocks.getLowStock.mockResolvedValue({ total: 0, items: [] });
    mocks.listMySales.mockResolvedValue([]);
    mocks.getSalesTotals.mockResolvedValue({ from: '2027-12-10', to: '2027-12-10', saleCount: 0, voidedCount: 0, total: '0.00', voidedTotal: '0.00', subtotal: '0.00', tax: '0.00' });
    mocks.getMySalesTotals.mockResolvedValue({ from: '2027-12-10', to: '2027-12-10', saleCount: 0, voidedCount: 0, total: '0.00', voidedTotal: '0.00', subtotal: '0.00', tax: '0.00' });
    mocks.getSetupFlags.mockResolvedValue({ items: [], counts: { missing_barcode: 0, not_stock_tracked: 0 } });
    mocks.listProductsImports.mockResolvedValue([]);
    mocks.listBarcodes.mockResolvedValue([]);
    mocks.listProducts.mockResolvedValue([]);
    mocks.getStockOnHand.mockResolvedValue({});
    mocks.getPendingOnlineSale.mockResolvedValue(null);
    mocks.listOnlineSalesNeedingReview.mockResolvedValue([]);
    scanner.cameraSupported.mockReturnValue(false);
  });

  describe('wastage', () => {
    it('shows a Wastage tab to a cashier with pos.stock_view, locked to this outlet, and not to one without', async () => {
      const { unmount } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={new Set(['supermarket.sales', 'pos.stock_view'])} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Wastage' }));
      expect(screen.getByTestId('stock-wastage')).toHaveTextContent('wastage at Mini Mart');
      unmount();

      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await screen.findByRole('tab', { name: 'Sell' });
      expect(screen.queryByRole('tab', { name: 'Wastage' })).not.toBeInTheDocument();
    });
  });

  describe('sales reports: date range and totals', () => {
    const BD = { ...PROPERTY, current_business_date: '2027-12-10' };
    const BY_METHOD = [
      { method: 'cash', saleCount: 2, total: '800.00' },
      { method: 'terminal', saleCount: 1, total: '234.50' },
      { method: 'online_transfer', saleCount: 1, total: '200.00' },
    ];
    const TOTALS = { from: '2027-12-10', to: '2027-12-10', saleCount: 3, voidedCount: 1, total: '1234.50', voidedTotal: '20.00', subtotal: '1234.50', tax: '0.00', byMethod: BY_METHOD };
    const openSales = async (perms = MANAGER, props = BD) => {
      render(<SupermarketScreen activeProperty={props} permissions={perms} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
    };

    it('All sales defaults to the business date, shows the total, the count and the voided count from the server', async () => {
      mocks.getSalesTotals.mockResolvedValue(TOTALS);
      await openSales();
      const strip = await screen.findByRole('group', { name: 'Sales totals' });
      expect(within(strip).getByText(/1,234\.50/)).toBeInTheDocument();
      expect(within(strip).getByText('3')).toBeInTheDocument();
      expect(within(strip).getByText('1')).toBeInTheDocument(); // voided
      expect(within(strip).getByText(/not counted/)).toBeInTheDocument();
      expect(screen.getByLabelText('From')).toHaveValue('2027-12-10');
      expect(screen.getByLabelText('To')).toHaveValue('2027-12-10');
      expect(mocks.listSales).toHaveBeenCalledWith({ outletId: '5', from: '2027-12-10', to: '2027-12-10' });
      expect(mocks.getSalesTotals).toHaveBeenCalledWith({ outletId: '5', from: '2027-12-10', to: '2027-12-10' });
    });

    it('splits the total by how it was paid (cash, card machine, online transfer), as the server summed it', async () => {
      mocks.getSalesTotals.mockResolvedValue(TOTALS);
      await openSales();
      const list = await screen.findByRole('list', { name: 'Sales by payment method' });
      const rows = within(list).getAllByRole('listitem').map((row) => row.textContent);
      expect(rows[0]).toMatch(/Cash.*800\.00.*2 sales/);
      expect(rows[1]).toMatch(/Card \(terminal\).*234\.50.*1 sale/);
      expect(rows[2]).toMatch(/Online: bank transfer.*200\.00.*1 sale/);
    });

    it("shows no split when the server sent none (the total is still shown)", async () => {
      mocks.getSalesTotals.mockResolvedValue({ ...TOTALS, byMethod: undefined });
      await openSales();
      await screen.findByRole('group', { name: 'Sales totals' });
      expect(screen.queryByRole('list', { name: 'Sales by payment method' })).not.toBeInTheDocument();
    });

    it('changing the dates, or a shortcut, reloads the list and the total for that range', async () => {
      await openSales();
      await screen.findByRole('group', { name: 'Sales totals' });
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-12-01' } });
      await waitFor(() => expect(mocks.getSalesTotals).toHaveBeenLastCalledWith({ outletId: '5', from: '2027-12-01', to: '2027-12-10' }));
      expect(mocks.listSales).toHaveBeenLastCalledWith({ outletId: '5', from: '2027-12-01', to: '2027-12-10' });
      await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
      await waitFor(() => expect(mocks.getSalesTotals).toHaveBeenLastCalledWith({ outletId: '5', from: '2027-12-04', to: '2027-12-10' }));
      await userEvent.click(screen.getByRole('button', { name: 'This month' }));
      await waitFor(() => expect(mocks.getSalesTotals).toHaveBeenLastCalledWith({ outletId: '5', from: '2027-12-01', to: '2027-12-10' }));
      await userEvent.click(screen.getByRole('button', { name: 'Today' }));
      await waitFor(() => expect(mocks.getSalesTotals).toHaveBeenLastCalledWith({ outletId: '5', from: '2027-12-10', to: '2027-12-10' }));
    });

    it('does not ask the server for a range that starts after it ends, and says so', async () => {
      await openSales();
      await screen.findByRole('group', { name: 'Sales totals' });
      const calls = mocks.getSalesTotals.mock.calls.length;
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-12-20' } });
      expect(await screen.findByText('The start date must not be after the end date.')).toBeInTheDocument();
      expect(mocks.getSalesTotals.mock.calls.length).toBe(calls);
    });

    it('says the list shows only the latest sales when the total counts more', async () => {
      mocks.listSales.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), receipt_number: i + 1, created_at: '2027-12-10T10:00:00', method: 'cash', total: '10.00', currency: 'NGN', voided_at: null })));
      mocks.getSalesTotals.mockResolvedValue({ ...TOTALS, saleCount: 205, voidedCount: 0, total: '2050.00' });
      await openSales();
      expect(await screen.findByText(/Showing the latest 100 of 205 sales; the total above counts all of them/)).toBeInTheDocument();
    });

    it('shows the list even if the total cannot load, with the reason', async () => {
      mocks.listSales.mockResolvedValue([{ id: '90', receipt_number: 7, created_at: '2027-12-10T10:00:00', method: 'cash', total: '134.38', currency: 'NGN', voided_at: null }]);
      mocks.getSalesTotals.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'totals broke', status: 500 }));
      await openSales();
      expect(await screen.findByText('totals broke')).toBeInTheDocument();
      expect(await screen.findByText('#7')).toBeInTheDocument();
    });

    it('drops an older answer that arrives after a newer range was chosen', async () => {
      let releaseFirst;
      mocks.getSalesTotals.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve({ ...TOTALS, total: '1111.00' }))));
      mocks.getSalesTotals.mockResolvedValue({ ...TOTALS, total: '2222.00' });
      await openSales();
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-12-01' } });
      expect(await screen.findByText(/2,222\.00/)).toBeInTheDocument();
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText(/1,111\.00/)).not.toBeInTheDocument();
    });

    it('an invalid range also supersedes an answer still in flight (no stale list under the warning)', async () => {
      let releaseSlow;
      mocks.listSales.mockImplementation(({ from }) => (from === '2027-12-01' ? new Promise((resolve) => (releaseSlow = () => resolve([{ id: '1', receipt_number: 1, created_at: '2027-12-01T10:00:00', method: 'cash', total: '9.99', currency: 'NGN', voided_at: null }]))) : Promise.resolve([])));
      await openSales();
      await screen.findByRole('group', { name: 'Sales totals' });
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-12-01' } }); // slow, valid
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2027-12-20' } }); // invalid: supersedes it
      expect(await screen.findByText('The start date must not be after the end date.')).toBeInTheDocument();
      releaseSlow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText('#1')).not.toBeInTheDocument();
    });

    it("switching outlet clears the previous outlet's total at once and never lets its slow answer land", async () => {
      mocks.listMyOutlets.mockResolvedValue([{ id: '5', name: 'Mini Mart' }, { id: '6', name: 'Second Mart' }]);
      mocks.getSalesTotals.mockImplementation(({ outletId }) => (outletId === '5' ? Promise.resolve({ ...TOTALS, total: '1111.00' }) : new Promise((resolve) => setTimeout(() => resolve({ ...TOTALS, total: '2222.00' }), 30))));
      render(<SupermarketScreen activeProperty={BD} permissions={MANAGER} />);
      await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '5');
      await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
      expect(await screen.findByText(/1,111\.00/)).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText('Outlet'), '6');
      expect(screen.queryByText(/1,111\.00/)).not.toBeInTheDocument(); // not shown for the new outlet
      expect(await screen.findByText(/2,222\.00/)).toBeInTheDocument();
    });

    it("disables the date controls offline", async () => {
      render(<SupermarketScreen activeProperty={BD} permissions={MANAGER} isOffline />);
      await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
      expect(await screen.findByLabelText('From')).toBeDisabled();
      expect(screen.getByLabelText('To')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeDisabled();
    });

    it("Today's sales shows the cashier's own total, count and voided count", async () => {
      mocks.getMySalesTotals.mockResolvedValue({ ...TOTALS, total: '480.00', saleCount: 4, voidedCount: 0, byMethod: [{ method: 'cash', saleCount: 3, total: '300.00' }, { method: 'online_card', saleCount: 1, total: '180.00' }] });
      render(<SupermarketScreen activeProperty={BD} permissions={SELLER} />);
      await userEvent.click(await screen.findByRole('tab', { name: "Today's sales" }));
      const strip = await screen.findByRole('group', { name: "Today's sales totals" });
      expect(within(strip).getByText(/480\.00/)).toBeInTheDocument();
      expect(within(strip).getByText('4')).toBeInTheDocument();
      expect(within(strip).queryByText('Voided')).not.toBeInTheDocument();
      const split = within(screen.getByRole('list', { name: "Today's sales by payment method" })).getAllByRole('listitem').map((row) => row.textContent);
      expect(split[0]).toMatch(/Cash.*300\.00/);
      expect(split[1]).toMatch(/Online: card.*180\.00/);
      expect(mocks.getMySalesTotals).toHaveBeenCalledWith('5');
      expect(mocks.getSalesTotals).not.toHaveBeenCalled(); // a cashier has no All sales report
    });
  });

  describe('requesting stock', () => {
    const CASHIER = new Set(['supermarket.sales', 'pos.stock_request']);

    it('shows a Request stock tab to a cashier who can request, fixed to this outlet, and not to one who cannot', async () => {
      const { unmount } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={CASHIER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Request stock' }));
      expect(screen.getByTestId('stock-requests')).toHaveTextContent('requests for 5');
      expect(screen.getByText(/you cannot add stock yourself/i)).toBeInTheDocument();
      unmount();

      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await screen.findByRole('tab', { name: 'Sell' });
      expect(screen.queryByRole('tab', { name: 'Request stock' })).not.toBeInTheDocument();
    });

    it('offers Request stock on the low-stock banner and opens the tab', async () => {
      mocks.getLowStock.mockResolvedValue({ total: 1, items: [{ id: '1', name: 'Coke', unit: 'bottle', current_quantity: '2.000', reorder_level: '10.000' }] });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={CASHIER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Request stock' }));
      expect(await screen.findByTestId('stock-requests')).toBeInTheDocument();
    });

    it('does not offer the banner button without the request permission', async () => {
      mocks.getLowStock.mockResolvedValue({ total: 1, items: [{ id: '1', name: 'Coke', unit: 'bottle', current_quantity: '2.000', reorder_level: '10.000' }] });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(await screen.findByText(/low stock/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request stock' })).not.toBeInTheDocument();
    });
  });

  describe('scanning', () => {
    it('offers no Scan button where the device cannot use a camera, and keeps the typed box', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(await screen.findByLabelText(/scan a barcode/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Scan' })).not.toBeInTheDocument();
    });

    it('refuses a scanned product that is sold out at this outlet, typed or by camera', async () => {
      mocks.lookupBarcode.mockResolvedValue({ ...RICE, is_available: false });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await userEvent.type(await screen.findByLabelText(/scan a barcode/i), '6001{Enter}');
      expect(await screen.findByText('Rice 5kg is sold out at this outlet.')).toBeInTheDocument();
      expect(within(screen.getByRole('complementary', { name: 'Current sale' })).queryByText('Rice 5kg')).not.toBeInTheDocument();
      expect(mocks.searchItems).not.toHaveBeenCalled();
    });

    it('adds a camera read through the same lookup as the typed box, and returns to the box on Done', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      scanner.openCamera.mockResolvedValue({ id: 'stream' });
      scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
      scanner.readFrame.mockResolvedValueOnce('6001').mockResolvedValue(null);
      mocks.lookupBarcode.mockResolvedValue(RICE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Scan' }));
      expect(await screen.findByText('Added Rice 5kg', {}, { timeout: 3000 })).toBeInTheDocument();
      expect(mocks.lookupBarcode).toHaveBeenCalledWith('5', '6001');
      expect(screen.getByText('1 item in the sale')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('dialog', { name: 'Scan products' })).not.toBeInTheDocument();
      expect(screen.getByLabelText(/scan a barcode/i)).toHaveFocus();
      expect(within(screen.getByRole('complementary', { name: 'Current sale' })).getByText('Rice 5kg')).toBeInTheDocument();
    });

    it('closes the camera if the device goes offline mid-scan, and releases it', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      scanner.openCamera.mockResolvedValue({ id: 'stream' });
      scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
      scanner.readFrame.mockResolvedValue(null);
      const { rerender } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      const scanButton = await screen.findByRole('button', { name: 'Scan' });
      await userEvent.click(scanButton);
      expect(await screen.findByRole('dialog', { name: 'Scan products' })).toBeInTheDocument();
      rerender(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} isOffline />);
      expect(screen.queryByRole('dialog', { name: 'Scan products' })).not.toBeInTheDocument();
      expect(scanner.closeCamera).toHaveBeenCalledWith({ id: 'stream' });
      expect(scanButton).toBeDisabled(); // offline: nothing on the till takes focus, so none is forced back
    });

    it('shows the scanner diagnostics only when the page is opened with ?scandebug=1', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      scanner.openCamera.mockResolvedValue({ id: 'stream' });
      scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
      scanner.readFrame.mockResolvedValue(null);
      window.history.pushState({}, '', '/?scandebug=1');
      try {
        render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
        await userEvent.click(await screen.findByRole('button', { name: 'Scan' }));
        expect(await screen.findByLabelText('Scanner diagnostics', {}, { timeout: 3000 })).toBeInTheDocument();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('disables Scan while offline', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} isOffline />);
      expect(await screen.findByRole('button', { name: 'Scan' })).toBeDisabled();
    });
  });

  it('adds a scanned barcode to the cart and counts a second scan of the same product', async () => {
    mocks.lookupBarcode.mockResolvedValue(RICE);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

    const input = await screen.findByLabelText(/scan a barcode/i);
    await userEvent.type(input, '6001{Enter}');
    await userEvent.type(input, '6001{Enter}');

    expect(mocks.lookupBarcode).toHaveBeenCalledWith('5', '6001');
    const row = (await screen.findByText('Rice 5kg')).closest('tr');
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('falls back to a name search when the text is not a barcode, and adds the picked product', async () => {
    mocks.lookupBarcode.mockRejectedValue(notFound());
    mocks.searchItems.mockResolvedValue([SOAP]);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

    await userEvent.type(await screen.findByLabelText(/scan a barcode/i), 'soap{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: /Soap/ }));

    expect(mocks.searchItems).toHaveBeenCalledWith('5', 'soap');
    const cart = await screen.findByRole('complementary', { name: 'Current sale' });
    expect(within(cart).getByText('Soap')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    mocks.lookupBarcode.mockRejectedValue(notFound());
    mocks.searchItems.mockResolvedValue([]);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
    await userEvent.type(await screen.findByLabelText(/scan a barcode/i), 'zzz{Enter}');
    expect(await screen.findByText('No product matches "zzz".')).toBeInTheDocument();
  });

  it('completes a sale with the chosen method and shows the receipt with the tax the server charged', async () => {
    mocks.lookupBarcode.mockResolvedValue(RICE);
    mocks.createSale.mockResolvedValue(SALE);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

    await userEvent.type(await screen.findByLabelText(/scan a barcode/i), '6001{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Card (terminal)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));

    expect(mocks.createSale).toHaveBeenCalledWith(expect.objectContaining({ outletId: '5', method: 'terminal', items: [{ menu_item_id: '11', quantity: 1 }], idempotencyKey: expect.any(String) }));
    const receipt = await screen.findByTestId('supermarket-receipt');
    expect(within(receipt).getByText(/MART-000007/)).toBeInTheDocument();
    expect(within(receipt).getByText(/9\.38/)).toBeInTheDocument();
    // The cart is cleared for the next customer.
    expect(screen.getByText('Scan or search to start a sale.')).toBeInTheDocument();
  });

  it('reuses the same Idempotency-Key when the same cart is retried after a failure, and a new one after the cart changes', async () => {
    mocks.lookupBarcode.mockResolvedValue(RICE);
    mocks.createSale.mockRejectedValueOnce(new ApiError({ code: 'NETWORK_ERROR', message: 'Network down', status: null })).mockResolvedValue(SALE);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

    await userEvent.type(await screen.findByLabelText(/scan a barcode/i), '6001{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Complete sale' }));
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));

    const [first, second] = mocks.createSale.mock.calls.map(([args]) => args.idempotencyKey);
    expect(second).toBe(first);
  });

  describe('selling more than recorded stock', () => {
    const scanRice = async (times) => {
      const input = await screen.findByLabelText(/scan a barcode/i);
      for (let i = 0; i < times; i += 1) await userEvent.type(input, '6001{Enter}');
    };

    it('flags a cart line above stock, asks before selling, and sells only after "Sell anyway"', async () => {
      mocks.getStockOnHand.mockResolvedValue({ 11: 3 });
      mocks.lookupBarcode.mockResolvedValue(RICE);
      mocks.createSale.mockResolvedValue(SALE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await vi.waitFor(() => expect(mocks.getStockOnHand).toHaveBeenCalledWith('5'));
      await scanRice(3);
      const cart = screen.getByRole('complementary', { name: 'Current sale' });
      expect(within(cart).queryByText(/Only 3 in stock/)).not.toBeInTheDocument(); // 3 of 3 is fine
      await scanRice(1);
      expect(within(cart).getByText('Only 3 in stock')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
      const dialog = await screen.findByRole('dialog', { name: 'Sell more than recorded stock?' });
      expect(within(dialog).getByText(/4 in the sale, 3 in stock — 1 more than recorded/)).toBeInTheDocument();
      expect(mocks.createSale).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(mocks.createSale).not.toHaveBeenCalled();
      expect(within(cart).getByText('Rice 5kg')).toBeInTheDocument(); // the cart is kept

      await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
      await approveInDialog({ reason: 'Delivery counted wrong', confirmLabel: 'Sell anyway' });
      expect(approvalMocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'supermarket.oversell', approverUserId: '7', reason: 'Delivery counted wrong' }));
      expect(mocks.createSale).toHaveBeenCalledWith(expect.objectContaining({ items: [{ menu_item_id: '11', quantity: 4 }], confirmOversell: true, approval: TEST_APPROVAL_TOKEN }));
      expect(await screen.findByTestId('supermarket-receipt')).toBeInTheDocument();
      expect(mocks.getStockOnHand).toHaveBeenCalledTimes(2); // reloaded after the sale
    });

    it('sells up to exactly the stock on hand with no question, and never confirms on its own', async () => {
      mocks.getStockOnHand.mockResolvedValue({ 11: 3 });
      mocks.lookupBarcode.mockResolvedValue(RICE);
      mocks.createSale.mockResolvedValue(SALE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await vi.waitFor(() => expect(mocks.getStockOnHand).toHaveBeenCalled());
      await scanRice(3); // exactly the last 3
      await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
      expect(screen.queryByRole('dialog', { name: 'Sell more than recorded stock?' })).not.toBeInTheDocument();
      expect(mocks.createSale).toHaveBeenCalledWith(expect.objectContaining({ confirmOversell: false, approval: null }));
    });

    it('asks with the server\'s numbers when stock changed since the screen loaded, and resends on the same key', async () => {
      mocks.getStockOnHand.mockResolvedValue({}); // unknown on screen: nothing flagged
      mocks.lookupBarcode.mockResolvedValue(RICE);
      mocks.createSale
        .mockRejectedValueOnce(new ApiError({ code: 'BUSINESS_RULE_OVERSELL_NOT_CONFIRMED', message: 'This sale takes recorded stock below zero', status: 422, details: { lines: [{ name: 'Rice stock', unit: 'bag', on_hand: '3.000', needed: '10.000', projected: '-7.000' }] } }))
        .mockResolvedValue(SALE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await scanRice(1);
      await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
      const dialog = await screen.findByRole('dialog', { name: 'Sell more than recorded stock?' });
      expect(within(dialog).getByText(/10 bag needed, 3 on hand — stock goes to -7/)).toBeInTheDocument();
      await within(dialog).findByLabelText(/PIN/);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // a question, not an error
      await approveInDialog({ reason: 'Stock moved', confirmLabel: 'Sell anyway' });
      const [first, second] = mocks.createSale.mock.calls.map(([args]) => args);
      expect(first.confirmOversell).toBe(false);
      expect(second.confirmOversell).toBe(true);
      expect(second.approval).toBe(TEST_APPROVAL_TOKEN);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(await screen.findByTestId('supermarket-receipt')).toBeInTheDocument();
    });
  });

  it('shows no selling controls to a report-only user, but lists sales and cannot void', async () => {
    mocks.listSales.mockResolvedValue([{ id: '90', receipt_number: 7, created_at: '2027-09-01T10:00:00', method: 'cash', total: '134.38', currency: 'NGN', voided_at: null }]);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={REPORT_ONLY} />);

    // The sales rows have loaded (their Receipt button is there) before asserting what is absent.
    expect(await screen.findByRole('button', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/scan a barcode/i)).not.toBeInTheDocument();
    expect(screen.getByText(/view sales here but not sell/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it("voids a sale only once a manager approves it with their PIN and a reason", async () => {
    mocks.listSales.mockResolvedValue([{ id: '90', receipt_number: 7, created_at: '2027-09-01T10:00:00', method: 'cash', total: '134.38', currency: 'NGN', voided_at: null }]);
    mocks.voidSale.mockResolvedValue({ ...SALE, voided_at: '2027-09-01T11:00:00' });
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);

    await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Void' }));
    await approveInDialog({ reason: 'Wrong item', confirmLabel: 'Void sale' });

    expect(approvalMocks.requestApproval).toHaveBeenCalledWith({ action: 'supermarket.void_sale', approverUserId: '7', pin: '482915', reason: 'Wrong item', targetId: '90' });
    expect(mocks.voidSale).toHaveBeenCalledWith('90', 'Wrong item', TEST_APPROVAL_TOKEN);
  });

  it("lets a cashier start a void from Today's sales; a manager approves it", async () => {
    mocks.listMySales.mockResolvedValue([{ id: '91', receipt_code: 'MRT-8', receipt_number: 8, created_at: '2027-09-01T10:00:00', method: 'cash', total: '20.00', currency: 'NGN', voided_at: null }]);
    mocks.voidSale.mockResolvedValue({ ...SALE, id: '91', voided_at: '2027-09-01T11:00:00' });
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);

    await userEvent.click(await screen.findByRole('tab', { name: "Today's sales" }));
    await userEvent.click(await screen.findByRole('button', { name: 'Void' }));
    expect(await screen.findByRole('dialog', { name: 'Void receipt MRT-8?' })).toBeInTheDocument();
    await approveInDialog({ reason: 'Customer changed mind', confirmLabel: 'Void sale' });
    expect(mocks.voidSale).toHaveBeenCalledWith('91', 'Customer changed mind', TEST_APPROVAL_TOKEN);
  });

  it('explains when the user is assigned to no supermarket outlet', async () => {
    mocks.listMyOutlets.mockResolvedValue([]);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
    expect(await screen.findByText(/not assigned to a supermarket outlet/i)).toBeInTheDocument();
  });

  describe('Stage 2', () => {
    it('shows a low-stock banner with at most five items and a count of the rest, and nothing when the load fails', async () => {
      const items = Array.from({ length: 7 }, (_, n) => ({ id: String(n), name: `Item ${n}`, unit: 'pack', current_quantity: String(n), reorder_level: '5.000' }));
      mocks.getLowStock.mockResolvedValue({ total: 7, items });
      const { unmount } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      const banner = await screen.findByRole('status');
      expect(banner).toHaveTextContent('Item 4 4 (reorder at 5.000)');
      expect(banner).not.toHaveTextContent('Item 5');
      expect(banner).toHaveTextContent('and 2 more');
      unmount();

      mocks.getLowStock.mockRejectedValue(new Error('boom'));
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(await screen.findByLabelText(/scan a barcode/i)).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it("lets a cashier reprint one of today's sales, marked as a reprint", async () => {
      mocks.listMySales.mockResolvedValue([{ id: '90', receipt_code: 'MART-000007', total: '134.38', currency: 'NGN', created_at: '2027-09-01T10:00:00', voided_at: null }]);
      mocks.getSale.mockResolvedValue(SALE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await userEvent.click(await screen.findByRole('tab', { name: "Today's sales" }));
      await userEvent.click(await screen.findByRole('button', { name: 'Reprint' }));
      expect(mocks.getSale).toHaveBeenCalledWith('90');
      expect(await screen.findByText('Receipt MART-000007 (reprint)')).toBeInTheDocument();
    });

    it('lists products needing setup for a manager and adds a barcode, then refreshes', async () => {
      mocks.getSetupFlags
        .mockResolvedValueOnce({ items: [{ id: '31', name: 'Bare item', missing_barcode: true, not_stock_tracked: true }], counts: { missing_barcode: 1, not_stock_tracked: 1 } })
        .mockResolvedValue({ items: [{ id: '31', name: 'Bare item', missing_barcode: false, not_stock_tracked: true }], counts: { missing_barcode: 0, not_stock_tracked: 1 } });
      mocks.addBarcode.mockResolvedValue({ id: '1' });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      const list = await screen.findByRole('list', { name: 'Products needing setup' });
      expect(within(list).getByText(/No barcode/)).toBeInTheDocument();
      expect(within(list).getByText(/Not stock-tracked/)).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Barcode for Bare item'), '600999');
      await userEvent.click(screen.getByRole('button', { name: 'Add barcode' }));
      expect(mocks.addBarcode).toHaveBeenCalledWith('31', '600999');
      await vi.waitFor(() => expect(within(screen.getByRole('list', { name: 'Products needing setup' })).queryByText(/No barcode/)).not.toBeInTheDocument());
    });

    it('scans a barcode into a product\'s field with the camera, focuses it, and saves only on Add barcode', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      scanner.openCamera.mockResolvedValue({ id: 'stream' });
      scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
      scanner.readFrame.mockResolvedValueOnce('6009001').mockResolvedValue('6009999');
      mocks.getSetupFlags.mockResolvedValue({
        items: [
          { id: '31', name: 'Bare item', missing_barcode: true, not_stock_tracked: false },
          { id: '32', name: 'Other item', missing_barcode: true, not_stock_tracked: false },
        ],
        counts: { missing_barcode: 2, not_stock_tracked: 0 },
      });
      mocks.addBarcode.mockResolvedValue({ id: '1' });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Scan the barcode for Bare item' }));
      expect(await screen.findByRole('dialog', { name: 'Scan the barcode for Bare item' })).toBeInTheDocument();
      expect(screen.getByText('The barcode fills the field. Check it, then tap Add barcode.')).toBeInTheDocument();

      // One read: the view closes, the camera is released, that product's field holds the code and has focus.
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
      expect(scanner.closeCamera).toHaveBeenCalledWith({ id: 'stream' });
      expect(scanner.readFrame).toHaveBeenCalledTimes(1);
      const field = screen.getByLabelText('Barcode for Bare item');
      expect(field).toHaveValue('6009001');
      await vi.waitFor(() => expect(field).toHaveFocus()); // focus moves in an effect after the camera view unmounts
      expect(screen.getByLabelText('Barcode for Other item')).toHaveValue('');
      expect(mocks.addBarcode).not.toHaveBeenCalled(); // never added without the user's Add

      const row = field.closest('li');
      await userEvent.click(within(row).getByRole('button', { name: 'Add barcode' }));
      expect(mocks.addBarcode).toHaveBeenCalledWith('31', '6009001');
    });

    it('cancelling the Setup camera leaves the field as it was and adds nothing', async () => {
      scanner.cameraSupported.mockReturnValue(true);
      scanner.openCamera.mockResolvedValue({ id: 'stream' });
      scanner.loadDetector.mockResolvedValue({ detect: vi.fn() });
      scanner.readFrame.mockResolvedValue(null);
      mocks.getSetupFlags.mockResolvedValue({ items: [{ id: '31', name: 'Bare item', missing_barcode: true, not_stock_tracked: false }], counts: { missing_barcode: 1, not_stock_tracked: 0 } });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      await userEvent.type(await screen.findByLabelText('Barcode for Bare item'), '12');
      await userEvent.click(screen.getByRole('button', { name: 'Scan the barcode for Bare item' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(scanner.closeCamera).toHaveBeenCalledWith({ id: 'stream' });
      expect(screen.getByLabelText('Barcode for Bare item')).toHaveValue('12');
      expect(mocks.addBarcode).not.toHaveBeenCalled();
    });

    it('offers no Setup scan button without a usable camera, and disables it offline', async () => {
      mocks.getSetupFlags.mockResolvedValue({ items: [{ id: '31', name: 'Bare item', missing_barcode: true, not_stock_tracked: false }], counts: { missing_barcode: 1, not_stock_tracked: 0 } });
      const { unmount } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      await screen.findByLabelText('Barcode for Bare item');
      expect(screen.queryByRole('button', { name: 'Scan the barcode for Bare item' })).not.toBeInTheDocument();
      unmount();

      scanner.cameraSupported.mockReturnValue(true);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} isOffline />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      expect(await screen.findByRole('button', { name: 'Scan the barcode for Bare item' })).toBeDisabled();
    });

    it('shows the Products card on Setup, and a price change reloads the till menu and the setup flags', async () => {
      const product = { id: '31', name: 'Rice', category: 'Mart Groceries', price: '10.00', cost_price: null, stock_cost: null, status: 'active', barcodes: [], units_on_hand: null, shared_with: [] };
      mocks.listProducts.mockResolvedValue([product]);
      mocks.updateProduct.mockResolvedValue({ ...product, price: '12.00' });
      posMocks.listMenuItems.mockResolvedValue([]);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      const input = await screen.findByLabelText('Price for Rice');
      const menuCalls = posMocks.listMenuItems.mock.calls.length;
      const flagCalls = mocks.getSetupFlags.mock.calls.length;
      await userEvent.clear(input);
      await userEvent.type(input, '12.00');
      await userEvent.click(screen.getByRole('button', { name: 'Save price for Rice' }));
      expect(mocks.updateProduct).toHaveBeenCalledWith('31', '5', { price: '12.00' });
      await screen.findByRole('status');
      expect(posMocks.listMenuItems.mock.calls.length).toBeGreaterThan(menuCalls);
      expect(mocks.getSetupFlags.mock.calls.length).toBeGreaterThan(flagCalls);
    });

    it('shows the Barcodes card on Setup, and keeps it and "Products needing setup" in step', async () => {
      mocks.getSetupFlags
        .mockResolvedValueOnce({ items: [{ id: '31', name: 'Bare item', missing_barcode: true, not_stock_tracked: false }], counts: { missing_barcode: 1, not_stock_tracked: 0 } })
        .mockResolvedValue({ items: [], counts: { missing_barcode: 0, not_stock_tracked: 0 } });
      mocks.listBarcodes
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: '9', menu_item_id: '31', barcode: '600999', item_name: 'Bare item', item_status: 'active', on_till: true }]);
      mocks.addBarcode.mockResolvedValue({ id: '9' });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      expect(await screen.findByText('No barcodes yet. Add them under “Products needing setup”, or with Products import.')).toBeInTheDocument();
      expect(mocks.listBarcodes).toHaveBeenCalledWith('5');
      await userEvent.type(screen.getByLabelText('Barcode for Bare item'), '600999');
      await userEvent.click(screen.getByRole('button', { name: 'Add barcode' }));
      const list = await screen.findByRole('list', { name: 'Barcodes for Bare item' });
      expect(within(list).getByText('600999')).toBeInTheDocument();
    });

    it('hides the setup panel and does not load flags without the manage key', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await screen.findByLabelText(/scan a barcode/i);
      expect(screen.queryByText('Products needing setup')).not.toBeInTheDocument();
      expect(mocks.getSetupFlags).not.toHaveBeenCalled();
    });
  });

  describe('tile layout', () => {
    const MENU = [
      { id: '11', name: 'Rice 5kg', price: '107.50', category: 'Groceries', is_available: true, image_url: '/api/v1/media/menu-images/rice.png' },
      { id: '12', name: 'Soap', price: '10.00', category: 'Toiletries', is_available: true },
      { id: '13', name: 'Peak Milk 400g', price: '31.00', category: 'Groceries', is_available: false },
    ];

    beforeEach(() => {
      posMocks.listMenuItems.mockResolvedValue(MENU);
      posMocks.listMenuCategories.mockResolvedValue([{ name: 'Groceries' }, { name: 'Toiletries' }, { name: 'Snacks' }]);
    });

    it('shows the outlet menu as tiles with category tabs, and tapping a tile adds it to the sale', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      const grid = await screen.findByRole('group', { name: 'Products' });
      expect(posMocks.listMenuItems).toHaveBeenCalledWith('5');
      // A photo when there is one, else the product's initials.
      expect(within(grid).getByRole('button', { name: 'Add Rice 5kg' }).querySelector('img')).not.toBeNull();
      expect(within(grid).getByRole('button', { name: 'Add Soap' })).toHaveTextContent('S');
      expect(within(grid).getByRole('button', { name: 'Add Peak Milk 400g' })).toBeDisabled();
      expect(within(grid).getByRole('button', { name: 'Add Peak Milk 400g' })).toHaveTextContent('Sold out');
      // A registered category with nothing in it still shows, with its count.
      expect(screen.getByRole('tab', { name: 'Snacks 0' })).toBeInTheDocument();

      await userEvent.click(within(grid).getByRole('button', { name: 'Add Soap' }));
      await userEvent.click(within(grid).getByRole('button', { name: 'Add Soap' }));
      const row = within(screen.getByRole('complementary', { name: 'Current sale' })).getByText('Soap').closest('tr');
      expect(within(row).getByText('2')).toBeInTheDocument();
      expect(within(grid).getByRole('button', { name: 'Add Soap' })).toHaveTextContent('× 2');
    });

    it('shows units in stock on tracked tiles, and an item locked only by stock is not Sold out', async () => {
      posMocks.listMenuItems.mockResolvedValue([
        ...MENU,
        { id: '14', name: 'Bread', price: '5.00', category: 'Groceries', is_available: false, stock_auto_unavailable: true },
      ]);
      mocks.getStockOnHand.mockResolvedValue({ 11: 3, 12: null, 14: 0 });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      const grid = await screen.findByRole('group', { name: 'Products' });
      expect(await within(grid).findByText('3 in stock')).toBeInTheDocument();
      expect(within(grid).getByRole('button', { name: 'Add Soap' })).not.toHaveTextContent(/in stock/); // untracked
      const bread = within(grid).getByRole('button', { name: 'Add Bread' });
      expect(bread).toBeEnabled();
      expect(bread).toHaveTextContent('0 in stock');
      expect(within(grid).getByRole('button', { name: 'Add Peak Milk 400g' })).toHaveTextContent('Sold out'); // manual Sold out still blocks
    });

    it('filters the tiles by category', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Toiletries 1' }));
      const grid = screen.getByRole('group', { name: 'Products' });
      expect(within(grid).getAllByRole('button')).toHaveLength(1);
      expect(within(grid).getByRole('button', { name: 'Add Soap' })).toBeInTheDocument();
    });

    it('sells a tapped product through the same sale call as before', async () => {
      mocks.createSale.mockResolvedValue(SALE);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add Rice 5kg' }));
      await userEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
      expect(mocks.createSale).toHaveBeenCalledWith(expect.objectContaining({ outletId: '5', method: 'cash', items: [{ menu_item_id: '11', quantity: 1 }] }));
    });

    it('falls back to scan and search when the menu cannot be loaded', async () => {
      posMocks.listMenuItems.mockRejectedValue(new Error('down'));
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(await screen.findByText(/Product tiles could not be loaded/)).toBeInTheDocument();
      expect(screen.getByLabelText(/scan a barcode/i)).toBeEnabled();
    });

    it('disables the tiles while offline', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} isOffline />);
      expect(await screen.findByRole('button', { name: 'Add Soap' })).toBeDisabled();
    });

    it('jumps to the current sale from the phone order bar', async () => {
      const scrollIntoView = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(screen.queryByRole('button', { name: 'Review & pay' })).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole('button', { name: 'Add Soap' }));
      await userEvent.click(screen.getByRole('button', { name: 'Review & pay' }));
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it('offers only the tabs the role can use and opens a report-only user on All sales', async () => {
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={REPORT_ONLY} />);
      expect(await screen.findByRole('tab', { name: 'All sales' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Sell' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Setup' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Products import' })).not.toBeInTheDocument();
      expect(posMocks.listMenuItems).not.toHaveBeenCalled();
    });

    it('offers Products import to the manage key only, and opens it on that outlet', async () => {
      const { unmount } = render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await screen.findByRole('tab', { name: 'Sell' });
      expect(screen.queryByRole('tab', { name: 'Products import' })).not.toBeInTheDocument();
      unmount();

      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Products import' }));
      expect(await screen.findByText('Import products from a spreadsheet')).toBeInTheDocument();
      expect(mocks.listProductsImports).toHaveBeenCalledWith('5');
    });
  });

  describe('Online payment', () => {
    const ONLINE = { id: '31', status: 'pending', total: '109.12', currency: 'NGN', lines: [], sale: null };
    async function fillCart() {
      mocks.lookupBarcode.mockResolvedValue(RICE);
      await userEvent.type(await screen.findByLabelText(/scan a barcode/i), '6001{Enter}');
      await screen.findByText('Items total');
    }

    it('starts an online sale from the cart, opens the payment window, and shows the receipt once it completes', async () => {
      mocks.startOnlineSale.mockResolvedValue({ intent: ONLINE, accessCode: 'acc-1', checkoutUrl: 'u', qrDataUrl: 'data:image/png;base64,AAAA' });
      mocks.checkOnlineSale.mockResolvedValue({ intent: { ...ONLINE, status: 'completed', sale: { ...SALE, method: 'card' } }, checkError: null });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await fillCart();
      await userEvent.click(screen.getByRole('button', { name: 'Online payment' }));
      await userEvent.click(screen.getByRole('button', { name: 'Take online payment' }));
      expect(mocks.startOnlineSale).toHaveBeenCalledWith(expect.objectContaining({ outletId: '5', items: [{ menu_item_id: '11', quantity: 1 }] }));
      expect(mocks.createSale).not.toHaveBeenCalled();
      expect(await screen.findByRole('dialog', { name: 'Online payment (Paystack)' })).toBeInTheDocument();
      // The cart is kept until the payment lands.
      expect(within(screen.getByRole('complementary', { name: 'Current sale' })).getByText('Rice 5kg')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Check payment' }));
      expect(await screen.findByText('Online payment (Paystack)', { selector: 'dd' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Online payment (Paystack)' })).not.toBeInTheDocument();
      expect(screen.getByText('Scan or search to start a sale.')).toBeInTheDocument();
    });

    it('asks to confirm an oversell before an online sale, like a cash sale', async () => {
      mocks.getStockOnHand.mockResolvedValue({ 11: 0 });
      mocks.startOnlineSale.mockResolvedValue({ intent: ONLINE, accessCode: 'a', checkoutUrl: 'u', qrDataUrl: 'data:image/png;base64,AAAA' });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      await fillCart();
      await userEvent.click(screen.getByRole('button', { name: 'Online payment' }));
      await userEvent.click(screen.getByRole('button', { name: 'Take online payment' }));
      await screen.findByRole('dialog', { name: 'Sell more than recorded stock?' });
      expect(mocks.startOnlineSale).not.toHaveBeenCalled();
      await approveInDialog({ reason: 'Shelf count is behind', confirmLabel: 'Sell anyway' });
      expect(mocks.startOnlineSale).toHaveBeenCalledWith(expect.objectContaining({ confirmOversell: true, approval: TEST_APPROVAL_TOKEN }));
    });

    it('brings back this cashier\'s own waiting online payment after a reload', async () => {
      mocks.getPendingOnlineSale.mockResolvedValue(ONLINE);
      mocks.reopenOnlineCheckout.mockResolvedValue({ intent: ONLINE, accessCode: 'acc-1', checkoutUrl: 'u', qrDataUrl: 'data:image/png;base64,AAAA' });
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={SELLER} />);
      expect(await screen.findByRole('dialog', { name: 'Online payment (Paystack)' })).toBeInTheDocument();
      expect(mocks.reopenOnlineCheckout).toHaveBeenCalledWith('31');
    });

    it('labels sales by how they were paid, so an online card sale never reads as cash', async () => {
      mocks.listSales.mockResolvedValue([
        { ...SALE, id: '1', method: 'cash' },
        { ...SALE, id: '2', receipt_number: 8, method: 'terminal' },
        { ...SALE, id: '3', receipt_number: 9, method: 'card' },
      ]);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
      expect(await screen.findByText('Online payment (Paystack)')).toBeInTheDocument();
      expect(screen.getByText('Card (terminal)')).toBeInTheDocument();
      expect(screen.getAllByText('Cash')).toHaveLength(1);
    });

    it('warns a manager that voiding an online sale refunds the customer', async () => {
      mocks.listSales.mockResolvedValue([{ ...SALE, id: '3', receipt_number: 9, method: 'card' }]);
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Void' }));
      expect(await screen.findByText(/refunded in full through Paystack/)).toBeInTheDocument();
    });

    it('lists paid-but-unfinished online payments for a manager to refund, with a reason', async () => {
      mocks.listOnlineSalesNeedingReview.mockResolvedValueOnce([{ id: '44', total: '203.00', currency: 'NGN', review_reason: 'paid after the sale was cancelled', lines: [{ quantity: 2, item_name: 'Biscuit' }] }]).mockResolvedValue([]);
      mocks.refundOnlineSale.mockResolvedValue({});
      render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);
      await userEvent.click(await screen.findByRole('tab', { name: 'Setup' }));
      expect(await screen.findByText(/2 × Biscuit/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Refund' }));
      await approveInDialog({ reason: 'Paid after cancel', confirmLabel: 'Refund customer' });
      expect(approvalMocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'supermarket.refund_online', targetId: '44' }));
      expect(mocks.refundOnlineSale).toHaveBeenCalledWith('44', 'Paid after cancel', TEST_APPROVAL_TOKEN);
    });
  });
});
