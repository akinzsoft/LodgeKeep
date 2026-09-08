import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailSettingsTab } from '../EmailSettingsTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getEmailSettings: vi.fn(),
  updateEmailSettings: vi.fn(),
  sendTestEmail: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { getEmailSettings: mocks.getEmailSettings, updateEmailSettings: mocks.updateEmailSettings, sendTestEmail: mocks.sendTestEmail },
  };
});

describe('<EmailSettingsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getEmailSettings.mockResolvedValue(null);
  });

  it('shows a real message when a property has not been created yet', () => {
    render(<EmailSettingsTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('defaults the provider select to console (dev-only) with nothing configured yet', async () => {
    render(<EmailSettingsTab disabled={false} />);
    expect(await screen.findByRole('combobox')).toHaveValue('console');
    // SMTP-only fields stay hidden until the provider is switched.
    expect(screen.queryByPlaceholderText('mail.yourdomain.com')).not.toBeInTheDocument();
  });

  it('reveals SMTP fields when the provider is switched, and saves them', async () => {
    mocks.updateEmailSettings.mockResolvedValue({
      provider: 'smtp',
      smtp_host: 'mail.example.com',
      smtp_port: 465,
      smtp_user: 'a@example.com',
      smtp_from: null,
      smtp_from_name: null,
      smtp_password_set: true,
    });

    render(<EmailSettingsTab disabled={false} />);
    await screen.findByRole('combobox');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'smtp');

    await userEvent.type(screen.getByPlaceholderText('mail.yourdomain.com'), 'mail.example.com');
    await userEvent.type(screen.getByPlaceholderText('465'), '465');
    await userEvent.type(screen.getByPlaceholderText('you@yourdomain.com'), 'a@example.com');
    // No prior settings exist yet — the label carries no "already set"
    // suffix, unlike the masked-placeholder case tested separately below.
    await userEvent.type(screen.getByLabelText('Password'), 'a-real-password');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.updateEmailSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'smtp',
        smtp_host: 'mail.example.com',
        smtp_port: '465',
        smtp_user: 'a@example.com',
        smtp_password: 'a-real-password',
      })
    );
    expect(await screen.findByText('Email settings saved')).toBeInTheDocument();
  });

  it('never shows the real saved password back — the field starts blank with a note that it is already set', async () => {
    mocks.getEmailSettings.mockResolvedValue({
      provider: 'smtp',
      smtp_host: 'mail.example.com',
      smtp_port: 465,
      smtp_user: 'a@example.com',
      smtp_from: null,
      smtp_from_name: null,
      smtp_password_set: true,
    });
    render(<EmailSettingsTab disabled={false} />);
    const passwordInput = await screen.findByPlaceholderText('••••••••');
    expect(passwordInput).toHaveValue('');
    expect(screen.getByText(/already set — leave blank to keep it/i)).toBeInTheDocument();
  });

  it('surfaces a real backend save error', async () => {
    mocks.updateEmailSettings.mockRejectedValue(new ApiError({ code: 'VALIDATION_X', message: 'That host looks wrong.' }));
    render(<EmailSettingsTab disabled={false} />);
    await screen.findByRole('combobox');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'smtp');
    await userEvent.type(screen.getByPlaceholderText('mail.yourdomain.com'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That host looks wrong.')).toBeInTheDocument();
  });

  it('sends a real test email and shows a real success message', async () => {
    mocks.sendTestEmail.mockResolvedValue({ sent: true, provider: 'smtp', providerRef: 'ref-1' });
    render(<EmailSettingsTab disabled={false} />);
    await screen.findByRole('combobox');
    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(mocks.sendTestEmail).toHaveBeenCalledWith('me@example.com');
    expect(await screen.findByText(/sent via "smtp"/i)).toBeInTheDocument();
  });

  it('surfaces a real test-send failure', async () => {
    mocks.sendTestEmail.mockRejectedValue(new ApiError({ code: 'VALIDATION_EMAIL_TEST_SEND_FAILED', message: 'Test email could not be sent: DNS lookup failed.' }));
    render(<EmailSettingsTab disabled={false} />);
    await screen.findByRole('combobox');
    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    expect(await screen.findByText(/DNS lookup failed/)).toBeInTheDocument();
  });

  it('disables both save and test actions while offline', async () => {
    render(<EmailSettingsTab disabled={false} isOffline />);
    await screen.findByRole('combobox');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  });
});
