import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { POSScreen } from '../POSScreen.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listTerminals: vi.fn(),
  listMenuItems: vi.fn(),
  listOrders: vi.fn(),
  listShifts: vi.fn(),
  listGuestOrders: vi.fn(),
  listQrTokens: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  listStockTakes: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks, setupApi: { listRooms: vi.fn().mockResolvedValue([]) } };
});

describe('<POSScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listOrders.mockResolvedValue([]);
    mocks.listShifts.mockResolvedValue([]);
    mocks.listGuestOrders.mockResolvedValue([]);
    mocks.listQrTokens.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
    stockMocks.listStockTakes.mockResolvedValue([]);
  });

  it('defaults to the Register tab and switches between all seven tabs, including the PLAN.md Phase 6 QR-ordering and stock-control ones', async () => {
    render(<POSScreen />);
    expect(screen.getByRole('tab', { name: 'Register', selected: true })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(await screen.findByText('No open tabs right now.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Guest orders' }));
    expect(await screen.findByText('About this queue')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Shifts' }));
    expect(await screen.findByText('Open a shift')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'QR codes' }));
    expect(await screen.findByText('Outlets')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Stock' }));
    expect(await screen.findByRole('tab', { name: 'Stock items', selected: true })).toBeInTheDocument();
    expect(await screen.findByText('New stock item')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(await screen.findByText('New outlet')).toBeInTheDocument();
  });
});
