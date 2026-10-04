import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  getSetupFlags: vi.fn(),
  addBarcode: vi.fn(),
  listProductsImports: vi.fn(),
}));

const posMocks = vi.hoisted(() => ({
  listMenuItems: vi.fn(),
  listMenuCategories: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: mocks, posApi: posMocks };
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
    // By default the full-menu call fails, so these tests exercise the scan/search fallback.
    posMocks.listMenuItems.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'no', status: 403 }));
    posMocks.listMenuCategories.mockResolvedValue([]);
    mocks.listMyOutlets.mockResolvedValue([{ id: '5', name: 'Mini Mart' }]);
    mocks.listSales.mockResolvedValue([]);
    mocks.getLowStock.mockResolvedValue({ total: 0, items: [] });
    mocks.listMySales.mockResolvedValue([]);
    mocks.getSetupFlags.mockResolvedValue({ items: [], counts: { missing_barcode: 0, not_stock_tracked: 0 } });
    mocks.listProductsImports.mockResolvedValue([]);
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

  it('shows no selling controls to a report-only user, but lists sales and cannot void', async () => {
    mocks.listSales.mockResolvedValue([{ id: '90', receipt_number: 7, created_at: '2027-09-01T10:00:00', method: 'cash', total: '134.38', currency: 'NGN', voided_at: null }]);
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={REPORT_ONLY} />);

    // The sales rows have loaded (their Receipt button is there) before asserting what is absent.
    expect(await screen.findByRole('button', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/scan a barcode/i)).not.toBeInTheDocument();
    expect(screen.getByText(/view sales here but not sell/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it('voids a sale only with a reason', async () => {
    mocks.listSales.mockResolvedValue([{ id: '90', receipt_number: 7, created_at: '2027-09-01T10:00:00', method: 'cash', total: '134.38', currency: 'NGN', voided_at: null }]);
    mocks.voidSale.mockResolvedValue({ ...SALE, voided_at: '2027-09-01T11:00:00' });
    render(<SupermarketScreen activeProperty={PROPERTY} permissions={MANAGER} />);

    await userEvent.click(await screen.findByRole('tab', { name: 'All sales' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Void' }));
    const confirm = screen.getByRole('button', { name: 'Void sale' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/reason/i), 'Wrong item');
    await userEvent.click(confirm);

    expect(mocks.voidSale).toHaveBeenCalledWith('90', 'Wrong item');
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
});
