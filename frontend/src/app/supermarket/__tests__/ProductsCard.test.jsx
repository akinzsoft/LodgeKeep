import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ listProducts: vi.fn(), updateProduct: vi.fn(), archiveProduct: vi.fn(), restoreProduct: vi.fn() }));
const pos = vi.hoisted(() => ({ listMenuCategories: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, supermarketApi: api, posApi: pos };
});

import { ApiError } from '../../../shared/api/index.js';
import { ProductsCard } from '../ProductsCard.jsx';

const product = (overrides = {}) => ({
  id: '11',
  name: 'Rice 5kg',
  category: 'Mart Groceries',
  price: '107.50',
  cost_price: null,
  stock_cost: '80.00',
  status: 'active',
  barcodes: ['5449000000996'],
  units_on_hand: 12,
  shared_with: [],
  ...overrides,
});

const RICE = product();
const SOAP = product({ id: '12', name: 'Soap', category: 'Mart Toiletries', price: '10.00', barcodes: [], units_on_hand: null });

describe('<ProductsCard>', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    pos.listMenuCategories.mockReset();
    api.listProducts.mockResolvedValue([RICE, SOAP]);
    pos.listMenuCategories.mockResolvedValue([
      { id: '1', name: 'Mart Groceries', status: 'active' },
      { id: '2', name: 'Mart Toiletries', status: 'active' },
    ]);
  });

  it('lists the products with price and stock, filters by search and category', async () => {
    render(<ProductsCard outletId="5" />);
    const list = await screen.findByRole('list', { name: 'Products' });
    expect(within(list).getByText('Rice 5kg')).toBeInTheDocument();
    expect(within(list).getByText(/12 in stock/)).toBeInTheDocument();
    expect(screen.getByLabelText('Price for Rice 5kg')).toHaveValue('107.50');

    await userEvent.type(screen.getByLabelText(/search products/i), 'soap');
    expect(within(screen.getByRole('list', { name: 'Products' })).queryByText('Rice 5kg')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/search products/i));
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'Mart Toiletries');
    expect(within(screen.getByRole('list', { name: 'Products' })).queryByText('Rice 5kg')).not.toBeInTheDocument();
    expect(screen.getByText('Soap')).toBeInTheDocument();
  });

  it('saves a new price and says past sales are unchanged', async () => {
    const onChanged = vi.fn();
    api.updateProduct.mockResolvedValue({ ...RICE, price: '120.00' });
    render(<ProductsCard outletId="5" onChanged={onChanged} />);
    const input = await screen.findByLabelText('Price for Rice 5kg');
    expect(screen.getByRole('button', { name: 'Save price for Rice 5kg' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, '120.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save price for Rice 5kg' }));
    expect(api.updateProduct).toHaveBeenCalledWith('11', '5', { price: '120.00' });
    expect(await screen.findByRole('status')).toHaveTextContent(/now sells at 120\.00\. past sales keep the price they sold at/i);
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByLabelText('Price for Rice 5kg')).toHaveValue('120.00');
  });

  it('does not send a malformed price', async () => {
    render(<ProductsCard outletId="5" />);
    const input = await screen.findByLabelText('Price for Rice 5kg');
    await userEvent.clear(input);
    await userEvent.type(input, '12.345');
    await userEvent.click(screen.getByRole('button', { name: 'Save price for Rice 5kg' }));
    expect(api.updateProduct).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/2 decimal places/);
  });

  it("shows the server's reason and keeps the old price when a price change is refused", async () => {
    api.updateProduct.mockRejectedValue(new ApiError({ code: 'BUSINESS_RULE_PRODUCT_SHARED_WITH_HOTEL_OUTLET', message: 'also sold at BAR', status: 422 }));
    render(<ProductsCard outletId="5" />);
    const input = await screen.findByLabelText('Price for Rice 5kg');
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.click(screen.getByRole('button', { name: 'Save price for Rice 5kg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('also sold at BAR');
  });

  it('locks a product a hotel outlet also sells and says where', async () => {
    api.listProducts.mockResolvedValue([product({ shared_with: ['BAR'] })]);
    render(<ProductsCard outletId="5" />);
    expect(await screen.findByText('Also sold at BAR')).toBeInTheDocument();
    expect(screen.getByLabelText('Price for Rice 5kg')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Rice 5kg' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive Rice 5kg' })).toBeDisabled();
  });

  it('edits name, category and cost in a dialog and sends only what changed', async () => {
    api.updateProduct.mockResolvedValue({ ...RICE, name: 'Rice 10kg', category: 'Mart Toiletries', stock_cost: '85.00' });
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Rice 5kg' }));
    const dialog = screen.getByRole('alertdialog');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rice 10kg');
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'Mart Toiletries');
    const cost = within(dialog).getByLabelText('Cost price');
    await userEvent.clear(cost);
    await userEvent.type(cost, '85.00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(api.updateProduct).toHaveBeenCalledWith('11', '5', { name: 'Rice 10kg', category: 'Mart Toiletries', cost_price: '85.00' });
    expect(await screen.findByText('Rice 10kg was updated.')).toBeInTheDocument();
  });

  it('sends only the field that changed (a rename alone never touches category or cost)', async () => {
    api.updateProduct.mockResolvedValue({ ...RICE, name: 'Rice 5 kg' });
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Rice 5kg' }));
    const dialog = screen.getByRole('alertdialog');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rice 5 kg');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(api.updateProduct).toHaveBeenCalledWith('11', '5', { name: 'Rice 5 kg' });
  });

  it('closes the edit dialog without calling the server when nothing changed', async () => {
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Rice 5kg' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save changes' }));
    expect(api.updateProduct).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the edit dialog open with the reason when the server refuses (a duplicate name)', async () => {
    api.updateProduct.mockRejectedValue(new ApiError({ code: 'CONFLICT_PRODUCT_NAME_TAKEN', message: 'An active product named "Soap" already exists', status: 409 }));
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Rice 5kg' }));
    const dialog = screen.getByRole('alertdialog');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Soap');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('already exists');
  });

  it('will not save an edit with a blank name or a bad cost', async () => {
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Rice 5kg' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Rice');
    await userEvent.clear(within(dialog).getByLabelText('Cost price'));
    await userEvent.type(within(dialog).getByLabelText('Cost price'), '1.234');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('archives after a confirm and the product leaves the list; Show archived brings it back to restore', async () => {
    api.archiveProduct.mockResolvedValue({ ...RICE, status: 'archived' });
    api.restoreProduct.mockResolvedValue({ ...RICE, status: 'active' });
    render(<ProductsCard outletId="5" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Archive Rice 5kg' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/leaves the till/i);
    await userEvent.click(screen.getByRole('button', { name: 'Archive product' }));
    expect(api.archiveProduct).toHaveBeenCalledWith('11', '5', undefined);
    expect(await screen.findByText(/is archived and no longer on the till/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Price for Rice 5kg')).not.toBeInTheDocument();

    api.listProducts.mockResolvedValue([{ ...RICE, status: 'archived' }, SOAP]);
    await userEvent.click(screen.getByLabelText('Show archived'));
    expect(api.listProducts).toHaveBeenLastCalledWith('5', { includeArchived: true });
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Rice 5kg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore product' }));
    expect(api.restoreProduct).toHaveBeenCalledWith('11', '5', undefined);
  });

  it('disables every change while offline', async () => {
    render(<ProductsCard outletId="5" isOffline />);
    expect(await screen.findByLabelText('Price for Rice 5kg')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Rice 5kg' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive Rice 5kg' })).toBeDisabled();
  });

  it('says so when the products cannot be loaded, and when there are none', async () => {
    api.listProducts.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'boom', status: 500 }));
    const { unmount } = render(<ProductsCard outletId="5" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    unmount();
    api.listProducts.mockResolvedValue([]);
    render(<ProductsCard outletId="5" />);
    expect(await screen.findByText(/no active products/i)).toBeInTheDocument();
  });

  it('drops a stale answer after the outlet changes', async () => {
    let releaseFirst;
    api.listProducts.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve([RICE]))));
    api.listProducts.mockResolvedValueOnce([SOAP]);
    const { rerender } = render(<ProductsCard outletId="5" />);
    rerender(<ProductsCard outletId="6" />);
    expect(await screen.findByText('Soap')).toBeInTheDocument();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Rice 5kg')).not.toBeInTheDocument();
  });
});
