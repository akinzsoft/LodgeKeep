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
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

describe('<POSScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listOrders.mockResolvedValue([]);
    mocks.listShifts.mockResolvedValue([]);
  });

  it('defaults to the Register tab and switches between all four tabs', async () => {
    render(<POSScreen />);
    expect(screen.getByRole('tab', { name: 'Register', selected: true })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(await screen.findByText('No open tabs right now.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Shifts' }));
    expect(await screen.findByText('Open a shift')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(await screen.findByText('New outlet')).toBeInTheDocument();
  });
});
