import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TicketsTab, REFRESH_MS, ticketName, formatAge } from '../TicketsTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listKitchenTickets: vi.fn(),
  listOutlets: vi.fn(),
  markTicketDone: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: mocks };
});

const NOW = new Date('2026-09-13T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const ROOFTOP = {
  id: '70',
  outlet_id: '1',
  outlet_name: 'Main Bar',
  table_label: 'Rooftop 4',
  source: 'staff',
  guest_status: null,
  guest_name: null,
  opened_at: minutesAgo(35),
  items: [
    { id: '1', quantity: 2, name: 'Gulder', category: 'Beer', modifiers: null },
    { id: '2', quantity: 1, name: 'House Cocktail', category: 'Cocktails', modifiers: [{ name: 'Ice', option: 'No ice' }] },
  ],
};
const GUEST = {
  id: '73',
  outlet_id: '2',
  outlet_name: 'Kitchen',
  table_label: '6',
  source: 'guest',
  guest_status: 'preparing',
  guest_name: 'Ada',
  opened_at: minutesAgo(17),
  items: [{ id: '3', quantity: 4, name: 'Suya', category: 'Grill', modifiers: null }],
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('<TicketsTab>', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listOutlets.mockResolvedValue([
      { id: '1', name: 'Main Bar', status: 'active' },
      { id: '2', name: 'Kitchen', status: 'active' },
      { id: '3', name: 'Old Lounge', status: 'archived' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an empty state when there is nothing to make', async () => {
    mocks.listKitchenTickets.mockResolvedValue([]);
    render(<TicketsTab />);
    expect(await screen.findByText('No tickets to make right now.')).toBeInTheDocument();
  });

  it('shows a ticket card per tab with items, modifiers, outlet and how long it has waited', async () => {
    mocks.listKitchenTickets.mockResolvedValue([ROOFTOP, GUEST]);
    render(<TicketsTab />);

    const rooftop = await screen.findByRole('listitem', { name: 'Ticket #70, Rooftop 4' });
    expect(within(rooftop).getByRole('heading', { name: 'Rooftop 4' })).toBeInTheDocument();
    expect(within(rooftop).getByText('35 min')).toBeInTheDocument();
    expect(within(rooftop).getByText('Main Bar')).toBeInTheDocument();
    const items = within(within(rooftop).getByRole('list', { name: 'Items for ticket #70' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['2×Gulder', '1×House CocktailIce: No ice']);
    expect(within(rooftop).getByText('3 items')).toBeInTheDocument();

    // A guest QR order is labelled as one, with its table and status.
    const guest = screen.getByRole('listitem', { name: 'Ticket #73, Table 6' });
    expect(within(guest).getByText('Guest · Preparing')).toBeInTheDocument();
    expect(within(guest).getByRole('button', { name: 'Mark ticket #73 done' })).toBeInTheDocument();
    expect(within(guest).getByText('Ada')).toBeInTheDocument();
    expect(within(guest).getByText('17 min')).toBeInTheDocument();
    expect(screen.getByText('Open tickets · 2')).toBeInTheDocument();
  });

  it('refreshes by itself so new orders appear without leaving the tab', async () => {
    mocks.listKitchenTickets.mockResolvedValueOnce([ROOFTOP]).mockResolvedValue([ROOFTOP, GUEST]);
    render(<TicketsTab />);
    await screen.findByRole('listitem', { name: 'Ticket #70, Rooftop 4' });
    expect(screen.queryByRole('listitem', { name: 'Ticket #73, Table 6' })).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS);
    });
    expect(await screen.findByRole('listitem', { name: 'Ticket #73, Table 6' })).toBeInTheDocument();
    expect(mocks.listKitchenTickets).toHaveBeenCalledTimes(2);
  });

  it('refreshes on demand', async () => {
    mocks.listKitchenTickets.mockResolvedValueOnce([]).mockResolvedValue([ROOFTOP]);
    render(<TicketsTab />);
    await screen.findByText('No tickets to make right now.');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('listitem', { name: 'Ticket #70, Rooftop 4' })).toBeInTheDocument();
  });

  it('keeps the last tickets on screen when a refresh fails, and clears the warning once one succeeds', async () => {
    mocks.listKitchenTickets
      .mockResolvedValueOnce([ROOFTOP])
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'INTERNAL_ERROR', message: 'Service unavailable' }))
      .mockResolvedValue([ROOFTOP]);
    render(<TicketsTab />);
    await screen.findByRole('listitem', { name: 'Ticket #70, Rooftop 4' });

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't refresh (Service unavailable)");
    expect(screen.getByRole('listitem', { name: 'Ticket #70, Rooftop 4' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error state when the very first load fails', async () => {
    mocks.listKitchenTickets.mockRejectedValue(new Error('offline'));
    render(<TicketsTab />);
    expect(await screen.findByText('Could not load tickets.')).toBeInTheDocument();
  });

  it('narrows the queue to one outlet, offering only active outlets', async () => {
    mocks.listKitchenTickets.mockResolvedValue([ROOFTOP]);
    render(<TicketsTab />);
    await screen.findByRole('option', { name: 'Kitchen' });
    expect(screen.queryByRole('option', { name: 'Old Lounge' })).not.toBeInTheDocument();

    mocks.listKitchenTickets.mockResolvedValue([GUEST]);
    await userEvent.selectOptions(screen.getByLabelText('Outlet'), '2');
    const guest = await screen.findByRole('listitem', { name: 'Ticket #73, Table 6' });
    expect(mocks.listKitchenTickets).toHaveBeenLastCalledWith({ outletId: '2' });
    // The outlet name is redundant once filtered to it.
    expect(within(guest).queryByText('Kitchen')).not.toBeInTheDocument();
  });

  it("never shows the previous outlet's tickets when loading a newly picked outlet fails", async () => {
    mocks.listKitchenTickets.mockResolvedValue([ROOFTOP]);
    render(<TicketsTab />);
    await screen.findByRole('listitem', { name: 'Ticket #70, Rooftop 4' });

    mocks.listKitchenTickets.mockRejectedValue(new Error('offline'));
    await userEvent.selectOptions(await screen.findByLabelText('Outlet'), '2');
    expect(await screen.findByText('Could not load tickets.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Ticket #70, Rooftop 4' })).not.toBeInTheDocument();
  });

  it('marks a ticket done, taking it off the queue, and says so when that fails', async () => {
    mocks.listKitchenTickets.mockResolvedValueOnce([ROOFTOP, { ...GUEST, status: 'settled' }]).mockResolvedValue([ROOFTOP]);
    mocks.markTicketDone.mockResolvedValueOnce({ id: '73' }).mockRejectedValueOnce(new ApiError({ status: 409, code: 'CONFLICT', message: 'That tab was voided.' }));
    render(<TicketsTab />);
    const guest = await screen.findByRole('listitem', { name: 'Ticket #73, Table 6' });
    expect(within(guest).getByText('4 items · Paid')).toBeInTheDocument();

    await userEvent.click(within(guest).getByRole('button', { name: 'Mark ticket #73 done' }));
    expect(mocks.markTicketDone).toHaveBeenCalledWith('73');
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Ticket #73, Table 6' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Mark ticket #70 done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That tab was voided.');
    expect(screen.getByRole('listitem', { name: 'Ticket #70, Rooftop 4' })).toBeInTheDocument();
  });

  it('flags a paid guest order not yet accepted, with no Done button', async () => {
    mocks.listKitchenTickets.mockResolvedValue([{ ...GUEST, guest_status: 'received' }]);
    render(<TicketsTab />);
    const guest = await screen.findByRole('listitem', { name: 'Ticket #73, Table 6' });
    expect(within(guest).getByText('Guest · Not accepted yet')).toBeInTheDocument();
    expect(within(guest).getByText('Accept on Guest orders first')).toBeInTheDocument();
    expect(within(guest).queryByRole('button', { name: /done/i })).not.toBeInTheDocument();
  });

  it('names tickets and ages sensibly', () => {
    expect(ticketName({ source: 'staff', table_label: '  ' })).toBe('Walk-up');
    expect(ticketName({ source: 'guest', table_label: 'Room 204' })).toBe('Room 204');
    expect(ticketName({ source: 'guest', table_label: null })).toBe('Guest order');
    expect(formatAge(0)).toBe('Just now');
    expect(formatAge(60)).toBe('1 h');
    expect(formatAge(95)).toBe('1 h 35 min');
  });
});
