import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemplatesTab } from '../TemplatesTab.jsx';

const mocks = vi.hoisted(() => ({ downloadTemplate: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, migrationApi: { ...actual.migrationApi, downloadTemplate: mocks.downloadTemplate } };
});

vi.mock('../../../shared/download.js', () => ({ triggerDownload: vi.fn() }));

describe('<TemplatesTab>', () => {
  beforeEach(() => {
    mocks.downloadTemplate.mockReset();
  });

  it('shows one download button per entity type', async () => {
    render(<TemplatesTab />);
    expect(screen.getByRole('button', { name: /guest profiles/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reservations/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /company/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /outstanding ar balances/i })).toBeInTheDocument();
  });

  it('clicking a template button downloads the real CSV for that entity type', async () => {
    mocks.downloadTemplate.mockResolvedValue(new Blob(['first_name,last_name\n']));
    render(<TemplatesTab />);
    await userEvent.click(screen.getByRole('button', { name: /guest profiles/i }));
    await waitFor(() => expect(mocks.downloadTemplate).toHaveBeenCalledWith('guests'));
  });

  it('surfaces a real backend error without crashing the rest of the tab', async () => {
    mocks.downloadTemplate.mockRejectedValue(new Error('boom'));
    render(<TemplatesTab />);
    await userEvent.click(screen.getByRole('button', { name: /guest profiles/i }));
    expect(await screen.findByText('Could not download this template.')).toBeInTheDocument();
  });
});
