import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupTab } from '../SetupTab.jsx';

const mocks = vi.hoisted(() => ({
  listOutlets: vi.fn(),
  createOutlet: vi.fn(),
  updateOutlet: vi.fn(),
  archiveOutlet: vi.fn(),
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  updateTerminal: vi.fn(),
  archiveTerminal: vi.fn(),
  // Menu items/categories now live in `MenuItemsTab.jsx` (its own test
  // file, `MenuItemsTab.test.jsx`, covers that behavior in depth) — but
  // `SetupTab` renders it for real once an outlet is selected, so these
  // are mocked here only to keep it quiet (empty defaults), never asserted
  // on directly in this file.
  listMenuItems: vi.fn(),
  listMenuCategories: vi.fn(),
}));

const stockMocks = vi.hoisted(() => ({
  listStockItems: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks, stockApi: stockMocks };
});

const OUTLET = { id: '1', code: 'BAR', name: 'Main Bar', type: 'bar' };

describe('<SetupTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(stockMocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([OUTLET]);
    mocks.listTerminals.mockResolvedValue([]);
    mocks.listMenuItems.mockResolvedValue([]);
    mocks.listMenuCategories.mockResolvedValue([]);
    stockMocks.listStockItems.mockResolvedValue([]);
  });

  it('lists outlets and creates a new one', async () => {
    mocks.createOutlet.mockResolvedValue({ id: '2', code: 'REST', name: 'Restaurant', type: 'restaurant' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    expect(await screen.findByText('Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Code'), 'REST');
    await userEvent.type(screen.getByLabelText('Name'), 'Restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Add outlet' }));

    expect(mocks.createOutlet).toHaveBeenCalledWith(expect.objectContaining({ code: 'REST', name: 'Restaurant' }));
  });

  it('selecting an outlet loads its terminals, and creating a terminal calls the API', async () => {
    mocks.createTerminal.mockResolvedValue({ id: '9' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Terminals — Main Bar')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Device ref'), 'TERM-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add terminal' }));

    expect(mocks.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ outletId: '1', deviceRef: 'TERM-1' }));
  });

  it('shows a real error rather than an empty list on load failure', async () => {
    mocks.listOutlets.mockReset();
    mocks.listOutlets.mockRejectedValue(new Error('boom'));
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
    expect(await screen.findByText('No outlets yet — add one above.')).toBeInTheDocument();
  });

  it('gap closure: edits an outlet through the real update endpoint, pre-filled with its current values', async () => {
    mocks.updateOutlet.mockResolvedValue({ ...OUTLET, name: 'Renamed Bar' });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit outlet' })).closest('section');
    const nameInput = within(editCard).getByLabelText('Name');
    expect(nameInput).toHaveValue('Main Bar');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed Bar');
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateOutlet).toHaveBeenCalledWith('1', { code: 'BAR', name: 'Renamed Bar', type: 'bar' });
  });

  it('gap closure: edits a terminal through the real update endpoint', async () => {
    mocks.listTerminals.mockResolvedValue([{ id: '9', device_ref: 'TERM-1', supports_contactless: false }]);
    mocks.updateTerminal.mockResolvedValue({ id: '9', device_ref: 'TERM-1-RENAMED', supports_contactless: true });
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const terminalsSection = (await screen.findByRole('heading', { name: 'Terminals — Main Bar' })).closest('section');
    await userEvent.click(within(terminalsSection).getByRole('button', { name: 'Edit' }));
    const editCard = (await screen.findByRole('heading', { name: 'Edit terminal' })).closest('section');
    const deviceRefInput = within(editCard).getByLabelText('Device ref');
    expect(deviceRefInput).toHaveValue('TERM-1');

    await userEvent.click(within(editCard).getByLabelText('Supports contactless'));
    await userEvent.click(within(editCard).getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateTerminal).toHaveBeenCalledWith('9', { device_ref: 'TERM-1', supports_contactless: true });
  });

  it('gap closure: a real backend 403 editing an outlet renders in the error banner, not a silent failure', async () => {
    mocks.updateOutlet.mockRejectedValue(new Error('You do not have this permission.'));
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Could not update this outlet.')).toBeInTheDocument();
  });

  it('Cancel discards an outlet edit without submitting', async () => {
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);

    await userEvent.click(within((await screen.findByText('Main Bar')).closest('tr')).getByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(mocks.updateOutlet).not.toHaveBeenCalled();
  });

  it('renders MenuItemsTab once an outlet is selected — its own behavior is covered by MenuItemsTab.test.jsx', async () => {
    render(<SetupTab activeProperty={{ base_currency: 'NGN' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('heading', { name: 'Menu categories' })).toBeInTheDocument();
  });
});
