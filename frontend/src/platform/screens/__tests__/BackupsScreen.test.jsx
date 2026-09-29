import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider } from '../../auth/PlatformAuthContext.jsx';
import { BackupsScreen } from '../BackupsScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ listBackups: vi.fn(), startBackup: vi.fn(), configureApiClient: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks }, configureApiClient: mocks.configureApiClient };
});

const SENT = {
  id: '3',
  requested_at: '2026-09-29 10:00:00',
  requested_by: { email: 'ops@planmsys.test', name: 'Ops Admin' },
  recipient_email: 'owner@example.com',
  status: 'sent',
  size_bytes: '1048576',
  table_count: 104,
  row_count: '5120',
  file_name: 'lodgekeep-backup-20260929-100000.sql.gz.enc',
  email_provider: 'smtp',
  error: null,
};

function renderScreen() {
  return render(
    <PlatformAuthProvider>
      <BackupsScreen onBack={vi.fn()} onLogout={vi.fn()} />
    </PlatformAuthProvider>
  );
}

async function fillForm({ email = 'owner@example.com', pass = 'correct horse battery', again = pass } = {}) {
  await userEvent.type(screen.getByLabelText('Send to'), email);
  await userEvent.type(screen.getByLabelText(/^Passphrase/), pass);
  await userEvent.type(screen.getByLabelText('Type the passphrase again'), again);
}

describe('<BackupsScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listBackups.mockResolvedValue({ backups: [SENT], emailConfigured: true, emailProvider: 'smtp' });
  });

  it('shows the history: who, where, status, size and contents', async () => {
    renderScreen();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Ops Admin')).toBeInTheDocument();
    expect(within(table).getByText('owner@example.com')).toBeInTheDocument();
    expect(within(table).getByText('Sent')).toBeInTheDocument();
    expect(within(table).getByText('1.0 MB')).toBeInTheDocument();
    expect(within(table).getByText('104 tables, 5120 rows')).toBeInTheDocument();
    expect(within(table).getByText('lodgekeep-backup-20260929-100000.sql.gz.enc')).toBeInTheDocument();
  });

  it('asks for confirmation naming the address, then starts the backup with the passphrase and clears it', async () => {
    mocks.startBackup.mockResolvedValue({ id: '4', status: 'running', recipient_email: 'owner@example.com' });
    renderScreen();
    await screen.findByRole('table');
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/emailed to owner@example.com/)).toBeInTheDocument();
    expect(mocks.startBackup).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send backup' }));

    expect(mocks.startBackup).toHaveBeenCalledWith({ recipientEmail: 'owner@example.com', passphrase: 'correct horse battery' });
    expect(await screen.findByText('Backup #4 started — it will be emailed to owner@example.com in a moment.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Passphrase/)).toHaveValue('');
    expect(screen.getByLabelText('Type the passphrase again')).toHaveValue('');
  });

  it('will not start with a bad email, a short passphrase, or passphrases that differ', async () => {
    renderScreen();
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: 'Back up now' });

    await fillForm({ email: 'nope', pass: 'correct horse battery' });
    expect(button).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Send to'));
    await userEvent.type(screen.getByLabelText('Send to'), 'owner@example.com');
    expect(button).toBeEnabled();

    await userEvent.clear(screen.getByLabelText('Type the passphrase again'));
    await userEvent.type(screen.getByLabelText('Type the passphrase again'), 'something else entirely');
    expect(screen.getByText('The two passphrases do not match.')).toBeInTheDocument();
    expect(button).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/^Passphrase/));
    await userEvent.type(screen.getByLabelText(/^Passphrase/), 'short');
    expect(screen.getByText('The passphrase is too short.')).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('says so when the server has no mailbox, and blocks the button', async () => {
    mocks.listBackups.mockResolvedValue({ backups: [], emailConfigured: false, emailProvider: 'console' });
    renderScreen();
    expect(await screen.findByText(/no email mailbox configured/)).toBeInTheDocument();
    await fillForm();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  });

  it('shows the server refusal (e.g. a support-tier account) as an error', async () => {
    mocks.startBackup.mockRejectedValue(new ApiError({ status: 403, code: 'FORBIDDEN_PLATFORM_ROLE', message: 'This action requires the platform admin tier.' }));
    renderScreen();
    await screen.findByRole('table');
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Send backup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This action requires the platform admin tier.');
  });

  it('while a backup is running, the button waits and the history refreshes until it finishes', async () => {
    mocks.listBackups
      .mockResolvedValueOnce({ backups: [{ ...SENT, status: 'running', size_bytes: null, table_count: null, file_name: null }], emailConfigured: true, emailProvider: 'smtp' })
      .mockResolvedValue({ backups: [SENT], emailConfigured: true, emailProvider: 'smtp' });
    renderScreen();
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('A backup is running…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument(), { timeout: 5000 });
    expect(mocks.listBackups.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
