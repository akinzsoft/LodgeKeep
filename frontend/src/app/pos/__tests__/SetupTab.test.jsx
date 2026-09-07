import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupTab } from '../SetupTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  createOutlet: vi.fn(),
  archiveOutlet: vi.fn(),
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  archiveTerminal: vi.fn(),
  listMenuItems: vi.fn(),
  createMenuItem: vi.fn(),
  setMenuItemAvailability: vi.fn(),
  archiveMenuItem: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

const OUTLET = { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' };

describe('<SetupTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
  });

  it('lists outlets and creates a new one', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' });
    render(<SetupTab />);

    expect(await screen.findByText('Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Code'), 'REST');
    await userEvent.type(screen.getByLabelText('Name'), 'Restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));

    expect(mocks.createOutlet).toHaveBeenCalledWith(expect.objectContaining({ code: 'REST', name: 'Restaurant' }));
  });

  it('selecting an outlet loads its terminals and menu, and creating a terminal calls the API', async () => {
    mocks.createTerminal.mockResolvedValue({ id: '9' });
    render(<SetupTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Terminals — Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Device ref'), 'TERM-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add terminal' }));

    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', deviceRef: 'TERM-1' }));
  });

  it('toggles a menu item stock-out state', async () => {
    mocks.listMenuItems.mockResolvedValue([{ id: '5', name: 'Cocktail', category: 'Drinks', price: '20.00', is_available: true }]);
    mocks.setMenuItemAvailability.mockResolvedValue({});
    render(<SetupTab />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark stocked out' }));

    expect(mocks.setMenuItemAvailability).toHaveBeenCalledWith('5', false);
  });

  it('shows a real error rather than an empty list on load failure', async () => {
    mocks.listOutlets.mockReset();
    mocks.listOutlets.mockRejectedValue(new Error('boom'));
    render(<SetupTab />);
    expect(await screen.findByText('No outlets yet — add one above.')).toBeInTheDocument();
  });
});
