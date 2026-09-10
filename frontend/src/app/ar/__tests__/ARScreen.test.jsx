import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ARScreen } from '../ARScreen.jsx';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listCompanyProfiles: vi.fn(),
  getAgeingReport: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    arApi: { ...actual.arApi, listAccounts: mocks.listAccounts, getAgeingReport: mocks.getAgeingReport },
    profilesApi: { ...actual.profilesApi, listCompanyProfiles: mocks.listCompanyProfiles },
  };
});

describe('<ARScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listAccounts.mockResolvedValue([]);
    mocks.listCompanyProfiles.mockResolvedValue([]);
    mocks.getAgeingReport.mockResolvedValue({ rows: [], asOfDate: null, total: null });
  });

  it('defaults to the Accounts tab', async () => {
    render(<ARScreen />);
    expect(await screen.findByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/no AR accounts yet/i)).toBeInTheDocument();
  });

  it('switches to the Invoices tab', async () => {
    render(<ARScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Invoices' }));
    expect(screen.getByRole('tab', { name: 'Invoices' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Account')).toBeInTheDocument();
  });

  it('switches to the Ageing tab', async () => {
    render(<ARScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Ageing' }));
    expect(await screen.findByText(/aged balances by company/i)).toBeInTheDocument();
  });

  it('switches to the Payments tab', async () => {
    render(<ARScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Account')).toBeInTheDocument();
  });
});
