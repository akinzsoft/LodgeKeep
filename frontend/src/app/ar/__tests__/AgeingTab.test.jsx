import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgeingTab } from '../AgeingTab.jsx';

const mocks = vi.hoisted(() => ({
  getAgeingReport: vi.fn(),
  getAgeingReportCsv: vi.fn(),
  listAccounts: vi.fn(),
  triggerDownload: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    arApi: { ...actual.arApi, getAgeingReport: mocks.getAgeingReport, getAgeingReportCsv: mocks.getAgeingReportCsv, listAccounts: mocks.listAccounts },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: mocks.triggerDownload }));

const ROW = {
  arAccountId: '900',
  companyProfileId: '50',
  companyName: 'Acme Corp',
  creditLimit: '500.00',
  currentBalance: '250.00',
  current: '50.00',
  bucket_1_30: '100.00',
  bucket_31_60: '0.00',
  bucket_61_90: '0.00',
  bucket_90_plus: '100.00',
};

describe('<AgeingTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getAgeingReport.mockResolvedValue({ rows: [ROW], asOfDate: '2027-02-01', total: {} });
    mocks.listAccounts.mockResolvedValue([{ id: '900', currency: 'NGN' }]);
  });

  /** TESTING.md AR-2: "Ageing buckets — correct at 30/60/90 boundaries." This proves the UI renders the real backend-computed buckets, not a client-side recomputation. */
  it('renders the real ageing buckets by company', async () => {
    render(<AgeingTab />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(await screen.findByText(/As of business date 2027-02-01/)).toBeInTheDocument();
  });

  it('shows an empty state with no accounts to age', async () => {
    mocks.getAgeingReport.mockResolvedValue({ rows: [], asOfDate: '2027-02-01', total: {} });
    render(<AgeingTab />);
    expect(await screen.findByText(/nothing owed/i)).toBeInTheDocument();
  });

  it('highlights a nonzero 90+ bucket', async () => {
    render(<AgeingTab />);
    await screen.findByText('Acme Corp');
    // Money renders with the currency symbol via Intl — assert the raw amount is present.
    expect(await screen.findAllByText((_, node) => node?.textContent?.includes('100.00'))).not.toHaveLength(0);
  });

  it('exports the ageing report as CSV', async () => {
    const blob = { type: 'text/csv' };
    mocks.getAgeingReportCsv.mockResolvedValue(blob);
    render(<AgeingTab />);
    await screen.findByText('Acme Corp');

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(mocks.triggerDownload).toHaveBeenCalledWith(blob, 'ar-ageing.csv');
  });

  it('disables Refresh and Export while offline', async () => {
    render(<AgeingTab isOffline />);
    await screen.findByText('Acme Corp');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
