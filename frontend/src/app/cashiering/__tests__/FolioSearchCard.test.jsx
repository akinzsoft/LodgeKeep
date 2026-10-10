import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolioSearchCard } from '../FolioSearchCard.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ searchFolios: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, cashieringApi: mocks };
});

const row = (over = {}) => ({
  id: '9',
  guest_first_name: 'Ada',
  guest_last_name: 'Obi',
  guest_phone: '0803 555 1212',
  room_number: '204',
  arrival_date: '2027-01-01',
  departure_date: '2027-01-03',
  status: 'checked_in',
  folio_balance: '150.00',
  folio_currency: 'NGN',
  ...over,
});

async function search(text) {
  await userEvent.type(screen.getByLabelText(/guest name, phone number or room/i), text);
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('<FolioSearchCard>', () => {
  beforeEach(() => {
    mocks.searchFolios.mockReset();
  });

  it('sends the typed text to the server as-is', async () => {
    mocks.searchFolios.mockResolvedValue([]);
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('0803 555 1212');
    expect(mocks.searchFolios).toHaveBeenCalledWith('0803 555 1212');
  });

  it('trims surrounding spaces before searching', async () => {
    mocks.searchFolios.mockResolvedValue([]);
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('  ada  ');
    expect(mocks.searchFolios).toHaveBeenCalledWith('ada');
  });

  it('does not allow a second search while one is running', async () => {
    mocks.searchFolios.mockImplementation(() => new Promise(() => {}));
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('first');
    await userEvent.type(screen.getByLabelText(/guest name, phone number or room/i), '{enter}');
    expect(mocks.searchFolios).toHaveBeenCalledTimes(1);
  });

  it('lists several matches with name, room, dates and balance, and opens the chosen one', async () => {
    mocks.searchFolios.mockResolvedValue([row(), row({ id: '10', guest_first_name: 'Ada', guest_last_name: 'Eze', room_number: '305' })]);
    const onOpenFolio = vi.fn();
    render(<FolioSearchCard onOpenFolio={onOpenFolio} />);
    await search('ada');
    expect(await screen.findByText('Ada Obi')).toBeInTheDocument();
    expect(screen.getByText('Ada Eze')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.getAllByText(/₦150\.00/)).toHaveLength(2);
    expect(onOpenFolio).not.toHaveBeenCalled();

    await userEvent.click(screen.getAllByRole('button', { name: 'Open folio' })[1]);
    expect(onOpenFolio).toHaveBeenCalledWith('10');
  });

  it('opens the folio straight away when exactly one guest matches', async () => {
    mocks.searchFolios.mockResolvedValue([row()]);
    const onOpenFolio = vi.fn();
    render(<FolioSearchCard onOpenFolio={onOpenFolio} />);
    await search('204');
    await vi.waitFor(() => expect(onOpenFolio).toHaveBeenCalledWith('9'));
  });

  it('shows dashes for a checked-out guest with no room or open balance', async () => {
    mocks.searchFolios.mockResolvedValue([
      row({ status: 'checked_out', room_number: null, folio_balance: null }),
      row({ id: '11' }),
    ]);
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('obi');
    expect(await screen.findByText('Checked out')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    mocks.searchFolios.mockResolvedValue([]);
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('nobody');
    expect(await screen.findByText(/no in-house or recently checked-out guest matches/i)).toBeInTheDocument();
  });

  it('shows the server error', async () => {
    mocks.searchFolios.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Search failed upstream' }));
    render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    await search('ada');
    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed upstream');
  });

  it('disables Search offline and when the box is empty', async () => {
    const { rerender } = render(<FolioSearchCard onOpenFolio={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    rerender(<FolioSearchCard isOffline onOpenFolio={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/guest name, phone number or room/i), 'ada');
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });
});
