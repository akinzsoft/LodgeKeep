import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutstandingBalancesTab } from '../OutstandingBalancesTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listOutstandingBalances: vi.fn(),
  getOutstandingBalancesCsv: vi.fn(),
}));

const triggerDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, cashieringApi: mocks };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: triggerDownloadMock }));

const ROW = {
  id: '9',
  confirmation_number: 'CONF9',
  guest_first_name: 'Jordan',
  guest_last_name: 'Fixture',
  room_number: '204',
  arrival_date: '2027-01-01',
  departure_date: '2027-01-03',
  folio_balance: '150.00',
  folio_currency: 'NGN',
};

/**
 * Gap closure (user-reported): "Cashiering menu shld be able to see all
 * outstanding balance of guest and there room no. recommended a standard
 * feature."
 */
describe('<OutstandingBalancesTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    triggerDownloadMock.mockReset();
  });

  it('renders real rows with guest name, room, and a formatted balance', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([ROW]);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    expect(await screen.findByText('Jordan Fixture')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.getByText('CONF9')).toBeInTheDocument();
    expect(screen.getByText(/₦150\.00/)).toBeInTheDocument();
  });

  it('shows the real empty-state message when nothing is outstanding', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([]);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    expect(await screen.findByText(/no outstanding balances — every in-house folio is settled/i)).toBeInTheDocument();
  });

  it('shows the real backend error when the list fails to load', async () => {
    mocks.listOutstandingBalances.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Could not reach the ledger.' }));
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the ledger.');
  });

  it('a missing room number renders as a plain dash, not blank', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([{ ...ROW, room_number: null }]);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    await screen.findByText('Jordan Fixture');
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('"View folio" calls onViewFolio with the reservation id', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([ROW]);
    const onViewFolio = vi.fn();
    render(<OutstandingBalancesTab onViewFolio={onViewFolio} />);
    await screen.findByText('Jordan Fixture');

    await userEvent.click(screen.getByRole('button', { name: 'View folio' }));
    expect(onViewFolio).toHaveBeenCalledWith('9');
  });

  it('Refresh re-fetches the list', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([ROW]);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    await screen.findByText('Jordan Fixture');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.listOutstandingBalances).toHaveBeenCalledTimes(2);
  });

  it('Export CSV is disabled while there are no rows', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([]);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    await screen.findByText(/every in-house folio is settled/i);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it('Export CSV calls the real download when rows are present', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([ROW]);
    const fakeBlob = { type: 'text/csv' };
    mocks.getOutstandingBalancesCsv.mockResolvedValue(fakeBlob);
    render(<OutstandingBalancesTab onViewFolio={vi.fn()} />);
    await screen.findByText('Jordan Fixture');

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.getOutstandingBalancesCsv).toHaveBeenCalled();
    expect(triggerDownloadMock).toHaveBeenCalledWith(fakeBlob, 'outstanding-balances.csv');
  });

  it('disables Refresh and Export CSV while offline', async () => {
    mocks.listOutstandingBalances.mockResolvedValue([ROW]);
    render(<OutstandingBalancesTab isOffline onViewFolio={vi.fn()} />);
    await screen.findByText('Jordan Fixture');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
