import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { POSScreen } from '../POSScreen.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  listTerminals: vi.fn(),
  listMenuItems: vi.fn(),
  listMenuCategories: vi.fn(),
  listOrders: vi.fn(),
  listKitchenTickets: vi.fn(),
  listShifts: vi.fn(),
  listGuestOrders: vi.fn(),
  listQrTokens: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  listStockTakes: vi.fn(),
  listTransferRequests: vi.fn(),
  getTransferRequest: vi.fn(),
  getMyRequestOutlets: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks, setupApi: { listRooms: vi.fn().mockResolvedValue([]) } };
});

const STOCK_REQUEST = {
  id: '5',
  status: 'issued',
  note: null,
  fromOutlet: { id: '1', name: 'Main Store', type: 'store' },
  toOutlet: { id: '2', name: 'Main Bar' },
  requestedBy: { userId: '9', name: 'Bola Barman' },
  requestedAt: '2027-07-01T18:00:00Z',
  decidedBy: { userId: '4', name: 'Kemi Store' },
  decidedAt: '2027-07-01T19:00:00Z',
  decisionNote: null,
  lines: [{ stockItemId: '20', name: 'Coke', unit: 'bottle', archived: false, quantityRequested: '12.000', quantityIssued: '8.000', availableAtSource: null }],
};

describe('<POSScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listMenuCategories.mockResolvedValue([]);
    mocks.listOrders.mockResolvedValue([]);
    mocks.listKitchenTickets.mockResolvedValue([]);
    mocks.listShifts.mockResolvedValue([]);
    mocks.listGuestOrders.mockResolvedValue([]);
    mocks.listQrTokens.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
    stockMocks.listStockTakes.mockResolvedValue([]);
    stockMocks.listTransferRequests.mockResolvedValue([]);
    stockMocks.getTransferRequest.mockResolvedValue(STOCK_REQUEST);
    stockMocks.getMyRequestOutlets.mockResolvedValue({ restricted: false, outletIds: null });
  });

  describe('opened from a stock-request notification', () => {
    const MANAGER = new Set(['pos.operate', 'pos.stock_view', 'pos.stock_manage', 'pos.stock_transfer', 'pos.stock_request']);
    const INTENT = { posTab: 'stock', stockTab: 'requests', requestId: '5', nonce: 1 };

    it('lands on Stock → Requests with that request open', async () => {
      render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={MANAGER} intent={INTENT} />);
      expect(screen.getByRole('tab', { name: 'Stock', selected: true })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Requests', selected: true })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'Request #5 — Main Store → Main Bar' })).toBeInTheDocument();
      expect(stockMocks.getTransferRequest).toHaveBeenCalledWith('5');
    });

    it('a later click while POS is already open moves there too, once per click', async () => {
      const { rerender } = render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={MANAGER} />);
      expect(screen.getByRole('tab', { name: 'Register', selected: true })).toBeInTheDocument();

      rerender(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={MANAGER} intent={INTENT} />);
      expect(await screen.findByRole('heading', { name: 'Request #5 — Main Store → Main Bar' })).toBeInTheDocument();

      // The user moves on; re-rendering with the same (already applied) click does not drag them back.
      await userEvent.click(screen.getByRole('tab', { name: 'Shifts' }));
      rerender(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={MANAGER} intent={INTENT} />);
      expect(screen.getByRole('tab', { name: 'Shifts', selected: true })).toBeInTheDocument();

      rerender(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={MANAGER} intent={{ ...INTENT, nonce: 2 }} />);
      expect(screen.getByRole('tab', { name: 'Stock', selected: true })).toBeInTheDocument();
    });
  });

  it('defaults to the Register tab and switches between all seven tabs, including the PLAN.md Phase 6 QR-ordering and stock-control ones', async () => {
    render(<POSScreen activeProperty={{ base_currency: 'NGN' }} />);
    expect(screen.getByRole('tab', { name: 'Register', selected: true })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(await screen.findByText('No tickets to make right now.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Guest orders' }));
    expect(await screen.findByText('About this queue')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Shifts' }));
    expect(await screen.findByText('Open a shift')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'QR codes' }));
    expect(await screen.findByText('Outlets')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Stock' }));
    expect(await screen.findByRole('tab', { name: 'Stock items', selected: true })).toBeInTheDocument();
    // Stock is managed one outlet at a time; with no outlet yet, Stock items says where to add one.
    expect(await screen.findByText(/Add an outlet under POS → Setup first/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    // Setup opens on the shared catalogue; outlets are one view along.
    expect(await screen.findByRole('tab', { name: 'Catalogue (all outlets)', selected: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Outlets' }));
    expect(await screen.findByText('New outlet')).toBeInTheDocument();
  });

  it("bug fix: shows a real guard, not a crash, when no active property is resolved yet — every Money display below needs a real currency", () => {
    render(<POSScreen />);
    expect(screen.getByText('Choose a property from the Property box in the top bar to use the POS.')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Register' })).not.toBeInTheDocument();
  });
  describe('tabs follow the role', () => {
    const tabNames = () => within(screen.getByRole('tablist', { name: 'POS sections' })).getAllByRole('tab').map((tab) => tab.textContent);

    it('shows a POS operator only the tabs it can use', () => {
      render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.operate'])} />);
      expect(tabNames()).toEqual(['Register', 'Tickets', 'Guest orders', 'Shifts']);
    });

    it('shows a manager every tab', () => {
      const manager = new Set(['pos.operate', 'pos.manage', 'pos.stock_view', 'pos.stock_manage']);
      render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={manager} />);
      expect(tabNames()).toEqual(['Register', 'Tickets', 'Guest orders', 'Shifts', 'Sales', 'QR codes', 'Stock', 'Setup']);
    });

    it('lands a role without the Register on the first tab it can open', () => {
      render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.stock_view'])} />);
      expect(tabNames()).toEqual(['Stock']);
      expect(screen.getByRole('tab', { name: 'Stock', selected: true })).toBeInTheDocument();
    });

    it('ignores a notification intent for a tab the role cannot open', () => {
      render(<POSScreen activeProperty={{ base_currency: 'NGN' }} permissions={new Set(['pos.operate'])} intent={{ posTab: 'sales', nonce: 1 }} />);
      expect(screen.getByRole('tab', { name: 'Register', selected: true })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Sales' })).not.toBeInTheDocument();
    });
  });
});
