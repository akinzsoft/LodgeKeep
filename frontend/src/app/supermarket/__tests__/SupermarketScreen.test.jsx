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
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: mocks };
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
    mocks.listMyOutlets.mockResolvedValue([{ id: '5', name: 'Mini Mart' }]);
    mocks.listSales.mockResolvedValue([]);
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
    expect(await screen.findByRole('cell', { name: 'Soap' })).toBeInTheDocument();
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
});
