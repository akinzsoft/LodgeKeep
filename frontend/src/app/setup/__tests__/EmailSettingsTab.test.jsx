import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailSettingsTab } from '../EmailSettingsTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getEmailSettings: vi.fn(),
  updateEmailSettings: vi.fn(),
  sendTestEmail: vi.fn(),
  getEmailDeliveryStatus: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { getEmailSettings: mocks.getEmailSettings, updateEmailSettings: mocks.updateEmailSettings, sendTestEmail: mocks.sendTestEmail, getEmailDeliveryStatus: mocks.getEmailDeliveryStatus },
  };
});

const PLATFORM_STATUS = {
  sendsEmail: true,
  source: 'platform',
  mode: 'platform',
  platformConfigured: true,
  consoleAllowed: false,
  usage: { sentToday: 12, dailyCap: 500 },
  lastTest: null,
};

describe('<EmailSettingsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getEmailSettings.mockResolvedValue(null);
    mocks.getEmailDeliveryStatus.mockResolvedValue(PLATFORM_STATUS);
  });

  async function mode() {
    return screen.findByRole('combobox', { name: /send emails using/i });
  }

  it('shows a real message when a property has not been created yet', () => {
    render(<EmailSettingsTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('defaults to platform email, with the active mode, usage and no custom fields', async () => {
    render(<EmailSettingsTab disabled={false} />);
    expect(await mode()).toHaveValue('platform');
    expect(screen.getByText(/Platform email \(default\)/)).toBeInTheDocument();
    expect(screen.getByText(/12 of 500/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('mail.yourdomain.com')).not.toBeInTheDocument();
    expect(screen.getByText(/No test email has been sent yet/i)).toBeInTheDocument();
  });

  it('does not offer the console mode in production (the server says it is not allowed)', async () => {
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    expect(screen.queryByRole('option', { name: /console/i })).not.toBeInTheDocument();
  });

  it('offers the console mode only when the server allows it (development)', async () => {
    mocks.getEmailDeliveryStatus.mockResolvedValue({ ...PLATFORM_STATUS, consoleAllowed: true });
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    expect(screen.getByRole('option', { name: /console/i })).toBeInTheDocument();
  });

  it('warns loudly when the platform mailbox is not configured on the server, without naming secrets', async () => {
    mocks.getEmailDeliveryStatus.mockResolvedValue({ ...PLATFORM_STATUS, sendsEmail: false, source: 'none', platformConfigured: false, usage: null });
    render(<EmailSettingsTab disabled={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/platform email service is not configured on this server/i);
    expect(screen.getByText('Not sending')).toBeInTheDocument();
  });

  it('saves platform mode with an optional Reply-To', async () => {
    mocks.updateEmailSettings.mockResolvedValue({ mode: 'platform' });
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    await userEvent.type(screen.getByPlaceholderText(/super admin/i), 'front@hotel.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateEmailSettings).toHaveBeenCalledWith({ mode: 'platform', reply_to: 'front@hotel.example' });
    expect(await screen.findByText('Email settings saved')).toBeInTheDocument();
  });

  it('reveals the custom SMTP fields and saves them with port and security', async () => {
    mocks.updateEmailSettings.mockResolvedValue({ mode: 'custom' });
    render(<EmailSettingsTab disabled={false} />);
    await userEvent.selectOptions(await mode(), 'custom');
    await userEvent.type(screen.getByPlaceholderText('mail.yourdomain.com'), 'mail.example.com');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Port' }), '465');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Security' }), 'tls');
    await userEvent.type(screen.getByPlaceholderText('you@yourdomain.com'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateEmailSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'custom', smtp_host: 'mail.example.com', smtp_port: 465, smtp_security: 'tls', smtp_user: 'a@example.com', smtp_password: 'pw' })
    );
  });

  it('never shows the stored password: a masked placeholder, and blank on save keeps it', async () => {
    mocks.getEmailSettings.mockResolvedValue({ mode: 'custom', smtp_host: 'mail.example.com', smtp_port: 587, smtp_security: 'starttls', smtp_user: 'a@example.com', smtp_password_set: true });
    mocks.getEmailDeliveryStatus.mockResolvedValue({ ...PLATFORM_STATUS, mode: 'custom', source: 'custom', usage: null });
    mocks.updateEmailSettings.mockResolvedValue({ mode: 'custom' });
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    const password = screen.getByLabelText(/Password \(already set/);
    expect(password).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateEmailSettings.mock.calls[0][0].smtp_password).toBeUndefined();
  });

  it('shows a real server refusal (e.g. a blocked host) on save', async () => {
    mocks.updateEmailSettings.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_SMTP_HOST_REJECTED', message: 'That SMTP host points to a private or internal address, which is not allowed.' }));
    render(<EmailSettingsTab disabled={false} />);
    await userEvent.selectOptions(await mode(), 'custom');
    await userEvent.type(screen.getByPlaceholderText('mail.yourdomain.com'), '10.0.0.1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/private or internal address/)).toBeInTheDocument();
  });

  it('sends a test email to the signed-in user (no recipient field) and shows the result', async () => {
    mocks.sendTestEmail.mockResolvedValue({ sent: true, mode: 'platform', to: 'me@hotel.example' });
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText(/Test email sent to me@hotel\.example/)).toBeInTheDocument();
    expect(mocks.sendTestEmail).toHaveBeenCalledWith();
  });

  it('shows the send error text, and the last test result in the status', async () => {
    mocks.sendTestEmail.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_EMAIL_TEST_SEND_FAILED', message: 'Test email could not be sent: 535 Authentication failed' }));
    mocks.getEmailDeliveryStatus.mockResolvedValue({ ...PLATFORM_STATUS, lastTest: { at: '2026-10-16T10:00:00Z', ok: false, error: '535 Authentication failed' } });
    render(<EmailSettingsTab disabled={false} />);
    await mode();
    expect(screen.getByText(/Last test: failed — 535 Authentication failed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    const messages = await screen.findAllByText(/Authentication failed/);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('disables saving and testing while offline', async () => {
    render(<EmailSettingsTab disabled={false} isOffline />);
    await mode();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  });
});
