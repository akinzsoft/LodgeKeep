import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterTab } from '../RegisterTab.jsx';

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
  settleOrder: vi.fn(),
  findInHouseForCharge: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

const OUTLET = { id: '1', name: 'Main Bar' };
const TERMINAL = { id: '2', device_ref: 'BAR-TERM-1' };
const MENU_ITEM = { id: '3', name: 'House Cocktail', price: '20.00', is_available: true, category: 'Drinks' };
const SOLD_OUT_ITEM = { id: '4', name: 'Rare Steak', price: '40.00', is_available: false, category: 'Mains' };

function orderItem(overrides) {
  return { id: '1', menu_item_id: '3', quantity: 1, unit_price: '20.00', modifiers: null, split_group: null, voided_at: null, ...overrides };
}

/** `initialItems` seeds the FIRST `getOrder` resolution — the one `handleNewTab` itself triggers immediately after opening — so it must be queued before the "+ New tab" click, not after. */
async function openNewTab(initialItems = []) {
  const order = { id: '9', table_label: '', status: 'open' };
  render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
  await userEvent.selectOptions(await screen.findByLabelText('Outlet'), 'Main Bar');
  await userEvent.selectOptions(screen.getByLabelText('Terminal'), 'BAR-TERM-1');
  mocks.openOrder.mockResolvedValue(order);
  mocks.getOrder.mockResolvedValueOnce({ order, items: initialItems, settlements: [] });
  await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
  await screen.findByText('Total');
  return order;
}

describe('<RegisterTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([TERMINAL]);
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM]);
    mocks.listOrders.mockResolvedValue([]);
  });

  it('opens a new tab, adds an item by tapping its tile, and settles by cash', async () => {
    const order = { id: '9', table_label: '', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder
      .mockResolvedValueOnce({ order, items: [], settlements: [] })
      .mockResolvedValueOnce({ order, items: [{ id: '1', menu_item_id: '3', quantity: 1, unit_price: '20.00', modifiers: null, split_group: null, voided_at: null }], settlements: [] });
    mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), 'Main Bar');
    await userEvent.selectOptions(screen.getByLabelText('Terminal'), 'BAR-TERM-1');
    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));

    expect(mocks.openOrder).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', terminalId: '2' }));

    await userEvent.click(await screen.findByRole('button', { name: /House Cocktail/ }));
    expect(mocks.addItem).toHaveBeenCalledWith('9', expect.objectContaining({ menuItemId: '3', quantity: 1 }));

    expect(await screen.findByText('Total')).toBeInTheDocument();
    expect((await screen.findAllByText(/House Cocktail/)).length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole('button', { name: 'Settle' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm settlement' }));

    expect(mocks.settleOrder).toHaveBeenCalledWith('9', [expect.objectContaining({ method: 'cash' })]);
  });

  it('searches for an in-house guest when charging to room', async () => {
    const order = { id: '9', table_label: '', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder.mockResolvedValue({
      order,
      items: [{ id: '1', menu_item_id: '3', quantity: 1, unit_price: '20.00', modifiers: null, split_group: null, voided_at: null }],
      settlements: [],
    });
    mocks.findInHouseForCharge.mockResolvedValue([{ reservationId: '55', roomNumber: '204', guestFirstName: 'Ada', guestLastName: 'Bello' }]);

    render(<RegisterTab activeProperty={{ base_currency: 'NGN' }} />);
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), 'Main Bar');
    await userEvent.selectOptions(screen.getByLabelText('Terminal'), 'BAR-TERM-1');
    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
    await screen.findByText('Total');

    await userEvent.click(screen.getByRole('button', { name: 'Settle' }));

    await userEvent.click(screen.getByRole('button', { name: 'Charge to room' }));

    await userEvent.type(screen.getByPlaceholderText('Room number or guest name'), '204');
    expect(mocks.findInHouseForCharge).toHaveBeenCalledWith('204');
    expect(await screen.findByText(/Room 204 — Ada Bello/)).toBeInTheDocument();
  });

  it("bug fix: renders the active property's real currency, not a hardcoded NGN", async () => {
    const order = { id: '9', table_label: '', status: 'open' };
    mocks.openOrder.mockResolvedValue(order);
    mocks.getOrder.mockResolvedValue({ order, items: [], settlements: [] });

    render(<RegisterTab activeProperty={{ base_currency: 'KES' }} />);
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), 'Main Bar');
    await userEvent.selectOptions(screen.getByLabelText('Terminal'), 'BAR-TERM-1');
    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));

    // The menu tile (where a price renders) only mounts once a tab is open —
    // KES formats as "Ksh" via Intl (confirmed directly against the real
    // Intl.NumberFormat output, not assumed) — proves the currency actually
    // threaded through, not just that the component happened to still say
    // "NGN". Two real matches (the menu tile's own price and the running
    // total), so findAllByText — not findByText — is correct.
    expect((await screen.findAllByText(/Ksh/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument();
  });

  it('groups repeated taps on the same item into one line with a quantity badge, and "+" adds another', async () => {
    const order = await openNewTab();
    mocks.getOrder
      .mockResolvedValueOnce({ order, items: [orderItem({ id: '1' })], settlements: [] })
      .mockResolvedValueOnce({ order, items: [orderItem({ id: '1' }), orderItem({ id: '2' })], settlements: [] });

    await userEvent.click(screen.getByRole('button', { name: /House Cocktail/ }));
    expect(await screen.findByText('×1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Add another House Cocktail/ }));
    expect(mocks.addItem).toHaveBeenLastCalledWith('9', expect.objectContaining({ menuItemId: '3' }));
    expect(await screen.findByText('×2')).toBeInTheDocument();
    // One merged line, not two separate "×1" rows.
    expect(screen.queryByText('×1')).not.toBeInTheDocument();
  });

  it('voids the most recently added unit through a real ConfirmDialog, requiring a reason', async () => {
    const order = await openNewTab([orderItem({ id: '1' }), orderItem({ id: '2' })]);
    mocks.getOrder.mockResolvedValueOnce({ order, items: [orderItem({ id: '1' })], settlements: [] });

    await screen.findByText('×2');
    await userEvent.click(screen.getByRole('button', { name: /Remove one House Cocktail/ }));

    expect(screen.getByText('Void item')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Void' });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Guest changed their mind');
    await userEvent.click(confirmButton);

    // The LAST-added row (id "2"), not an arbitrary one.
    expect(mocks.voidOrderItem).toHaveBeenCalledWith('9', '2', 'Guest changed their mind');
    expect(await screen.findByText('×1')).toBeInTheDocument();
  });

  it('shows a sold-out item visibly, disabled, rather than hiding it', async () => {
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM, SOLD_OUT_ITEM]);
    await openNewTab();

    const soldOutTile = screen.getByRole('button', { name: /Rare Steak/ });
    expect(soldOutTile).toBeDisabled();
    expect(screen.getByText('Sold out')).toBeInTheDocument();

    await userEvent.click(soldOutTile);
    expect(mocks.addItem).not.toHaveBeenCalled();
  });

  it('filters the menu by category and by search text', async () => {
    mocks.listMenuItems.mockResolvedValue([MENU_ITEM, SOLD_OUT_ITEM]);
    await openNewTab();

    expect(screen.getByRole('button', { name: /House Cocktail/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rare Steak/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mains' }));
    expect(screen.queryByRole('button', { name: /House Cocktail/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rare Steak/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByLabelText('Search the menu'), 'cocktail');
    expect(screen.getByRole('button', { name: /House Cocktail/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rare Steak/ })).not.toBeInTheDocument();
  });

  it('settlement shows a real per-group subtotal, accepts tip/service charge, and submits them', async () => {
    const order = await openNewTab([orderItem()]);
    mocks.settleOrder.mockResolvedValue({ order: { ...order, status: 'settled' }, settlements: [] });

    await userEvent.click(screen.getByRole('button', { name: 'Settle' }));

    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getAllByText(/20\.00/).length).toBeGreaterThan(0);

    await userEvent.clear(screen.getByLabelText('Tip'));
    await userEvent.type(screen.getByLabelText('Tip'), '5');
    await userEvent.clear(screen.getByLabelText('Service charge'));
    await userEvent.type(screen.getByLabelText('Service charge'), '2');

    // 20 + 5 + 2 = 27 — a real computed grand total, not just echoing the subtotal.
    expect(await screen.findByText(/27\.00/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm settlement' }));
    expect(mocks.settleOrder).toHaveBeenCalledWith(
      '9',
      expect.arrayContaining([expect.objectContaining({ method: 'cash', tipAmount: '5', serviceCharge: '2' })])
    );
  });
});
