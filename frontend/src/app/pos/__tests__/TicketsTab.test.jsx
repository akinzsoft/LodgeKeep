import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TicketsTab } from '../TicketsTab.jsx';

const mocks = vi.hoisted(() => ({
  listOrders: vi.fn(),
  listMenuItems: vi.fn(),
  getOrder: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

describe('<TicketsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows an honest empty state with no open tabs', async () => {
    mocks.listOrders.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    render(<TicketsTab />);
    expect(await screen.findByText('No open tabs right now.')).toBeInTheDocument();
  });

  it('shows each open tab with its real item names, resolved from the menu — not a bare id', async () => {
    mocks.listOrders.mockResolvedValue([{ id: '7', table_label: 'T3' }]);
    mocks.listMenuItems.mockResolvedValue([{ id: '3', name: 'House Cocktail' }]);
    mocks.getOrder.mockResolvedValue({
      order: { id: '7' },
      items: [{ id: '1', menu_item_id: '3', quantity: 2, voided_at: null }],
      settlements: [],
    });
    render(<TicketsTab />);

    expect(await screen.findByText('Table T3')).toBeInTheDocument();
    expect(screen.getByText('House Cocktail')).toBeInTheDocument();
  });
});
