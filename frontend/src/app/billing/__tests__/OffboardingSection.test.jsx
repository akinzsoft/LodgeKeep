import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OffboardingSection } from '../OffboardingSection.jsx';

const mocks = vi.hoisted(() => ({
  getOffboardingStatus: vi.fn(),
  requestOffboarding: vi.fn(),
  retryExport: vi.fn(),
  downloadExport: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    offboardingApi: { ...actual.offboardingApi, ...mocks },
  };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: vi.fn() }));

describe('<OffboardingSection>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('an active tenant sees a request action, no export state', async () => {
    mocks.getOffboardingStatus.mockResolvedValue({ status: 'active', offboardingRequestedAt: null, retentionExpiresAt: null, latestExport: null });
    render(<OffboardingSection />);
    expect(await screen.findByRole('button', { name: /request offboarding/i })).toBeInTheDocument();
  });

  it('confirming the request dialog with a reason submits it and reloads the read-only state', async () => {
    mocks.getOffboardingStatus
      .mockResolvedValueOnce({ status: 'active', offboardingRequestedAt: null, retentionExpiresAt: null, latestExport: null })
      .mockResolvedValueOnce({
        status: 'offboarding',
        offboardingRequestedAt: '2026-09-11T00:00:00.000Z',
        retentionExpiresAt: '2026-10-11T00:00:00.000Z',
        latestExport: { id: '1', status: 'pending', reason: 'Leaving', fileSizeBytes: null, completedAt: null, downloadedAt: null, failedReason: null, createdAt: '2026-09-11' },
      });
    mocks.requestOffboarding.mockResolvedValue({ tenantId: '1', status: 'offboarding', exportId: '1' });

    render(<OffboardingSection />);
    await userEvent.click(await screen.findByRole('button', { name: /request offboarding/i }));

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Leaving the platform');
    await userEvent.click(within(dialog).getByRole('button', { name: /request offboarding/i }));

    await waitFor(() => expect(mocks.requestOffboarding).toHaveBeenCalledWith('Leaving the platform'));
    expect(await screen.findByText(/offboarding — read-only/i)).toBeInTheDocument();
    expect(await screen.findByText('Preparing')).toBeInTheDocument();
  });

  it('a failed export shows the failure reason and a retry action', async () => {
    mocks.getOffboardingStatus.mockResolvedValue({
      status: 'offboarding',
      offboardingRequestedAt: '2026-09-11T00:00:00.000Z',
      retentionExpiresAt: '2026-10-11T00:00:00.000Z',
      latestExport: { id: '1', status: 'failed', reason: null, fileSizeBytes: null, completedAt: null, downloadedAt: null, failedReason: 'Disk full', createdAt: '2026-09-11' },
    });
    mocks.retryExport.mockResolvedValue({ id: '2', status: 'pending' });

    render(<OffboardingSection />);
    expect(await screen.findByText('Disk full')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry export/i }));
    await waitFor(() => expect(mocks.retryExport).toHaveBeenCalledWith('1'));
  });

  it('a completed export offers a real download, which calls the download endpoint', async () => {
    mocks.getOffboardingStatus.mockResolvedValue({
      status: 'offboarding',
      offboardingRequestedAt: '2026-09-11T00:00:00.000Z',
      retentionExpiresAt: '2026-10-11T00:00:00.000Z',
      latestExport: { id: '1', status: 'completed', reason: null, fileSizeBytes: '2048', completedAt: '2026-09-11', downloadedAt: null, failedReason: null, createdAt: '2026-09-11' },
    });
    mocks.downloadExport.mockResolvedValue({});

    render(<OffboardingSection />);
    await userEvent.click(await screen.findByRole('button', { name: /download export/i }));
    await waitFor(() => expect(mocks.downloadExport).toHaveBeenCalledWith('1'));
  });

  it('surfaces a real backend error without crashing the rest of the screen', async () => {
    mocks.getOffboardingStatus.mockRejectedValue(new Error('boom'));
    render(<OffboardingSection />);
    expect(await screen.findByText('Could not load offboarding status.')).toBeInTheDocument();
  });

  it('disables the request action while offline', async () => {
    mocks.getOffboardingStatus.mockResolvedValue({ status: 'active', offboardingRequestedAt: null, retentionExpiresAt: null, latestExport: null });
    render(<OffboardingSection isOffline />);
    expect(await screen.findByRole('button', { name: /request offboarding/i })).toBeDisabled();
  });
});
