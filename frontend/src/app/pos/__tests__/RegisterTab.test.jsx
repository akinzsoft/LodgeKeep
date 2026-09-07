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
const MENU_ITEM = { id: '3', name: 'House Cocktail', price: '20.00', is_available: true };

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

    render(<RegisterTab />);

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

    render(<RegisterTab />);
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), 'Main Bar');
    await userEvent.selectOptions(screen.getByLabelText('Terminal'), 'BAR-TERM-1');
    await userEvent.click(screen.getByRole('button', { name: '+ New tab' }));
    await screen.findByText('Total');

    await userEvent.click(screen.getByRole('button', { name: 'Settle' }));

    const methodSelect = screen.getAllByRole('combobox').find((el) => el.value === 'cash');
    await userEvent.selectOptions(methodSelect, 'room_charge');

    await userEvent.type(screen.getByPlaceholderText('Room number or guest name'), '204');
    expect(mocks.findInHouseForCharge).toHaveBeenCalledWith('204');
    expect(await screen.findByText(/Room 204 — Ada Bello/)).toBeInTheDocument();
  });
});
