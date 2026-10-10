import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from '../SecurityTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getSecuritySettings: vi.fn(),
  setMfaRequirement: vi.fn(),
  getEmailDeliveryStatus: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, setupApi: { ...mocks } };
});

const PROPERTY = { id: '7', name: 'Alpha' };

describe('<SecurityTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getEmailDeliveryStatus.mockResolvedValue({ sendsEmail: true });
    mocks.getSecuritySettings.mockResolvedValue({ mfaRequiredForAdminRoles: true, canManage: true });
  });

  it('shows the state and the turn-off control to a super admin', async () => {
    render(<SecurityTab activeProperty={PROPERTY} />);
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off verification code/i })).toBeEnabled();
    expect(mocks.getSecuritySettings).toHaveBeenCalledWith('7');
  });

  it('shows a read-only note and no controls to anyone else', async () => {
    mocks.getSecuritySettings.mockResolvedValue({ mfaRequiredForAdminRoles: true, canManage: false });
    render(<SecurityTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/only a super admin can change this/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn off|require verification/i })).not.toBeInTheDocument();
  });

  it('turning off warns, needs a typed reason, and sends it', async () => {
    mocks.setMfaRequirement.mockResolvedValue({ mfaRequiredForAdminRoles: false });
    render(<SecurityTab activeProperty={PROPERTY} />);
    await userEvent.click(await screen.findByRole('button', { name: /turn off verification code/i }));

    expect(screen.getByText(/removes two-factor protection for admin accounts/i)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Turn off' });
    expect(confirm).toBeDisabled();
    expect(mocks.setMfaRequirement).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Mailbox down');
    await userEvent.click(confirm);

    expect(mocks.setMfaRequirement).toHaveBeenCalledWith('7', { required: false, reason: 'Mailbox down' });
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /require verification code/i })).toBeInTheDocument();
  });

  it('cancelling the confirmation changes nothing', async () => {
    render(<SecurityTab activeProperty={PROPERTY} />);
    await userEvent.click(await screen.findByRole('button', { name: /turn off verification code/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.setMfaRequirement).not.toHaveBeenCalled();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('turning back on needs no confirmation and no reason', async () => {
    mocks.getSecuritySettings.mockResolvedValue({ mfaRequiredForAdminRoles: false, canManage: true });
    mocks.setMfaRequirement.mockResolvedValue({ mfaRequiredForAdminRoles: true });
    render(<SecurityTab activeProperty={PROPERTY} />);
    await userEvent.click(await screen.findByRole('button', { name: /require verification code/i }));
    expect(mocks.setMfaRequirement).toHaveBeenCalledWith('7', { required: true, reason: undefined });
    expect(await screen.findByText('Required')).toBeInTheDocument();
  });

  it('shows the real server error and keeps the old state', async () => {
    mocks.setMfaRequirement.mockRejectedValue(new ApiError({ status: 403, code: 'FORBIDDEN_PERMISSION', message: 'Not allowed' }));
    render(<SecurityTab activeProperty={PROPERTY} />);
    await userEvent.click(await screen.findByRole('button', { name: /turn off verification code/i }));
    await userEvent.type(screen.getByLabelText('Reason'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('keeps the email-delivery warning, with security wording', async () => {
    mocks.getEmailDeliveryStatus.mockResolvedValue({ sendsEmail: false });
    render(<SecurityTab activeProperty={PROPERTY} />);
    expect(await screen.findByText(/emails from this property are not being sent/i)).toBeInTheDocument();
    expect(screen.getByText(/unable to sign in/i)).toBeInTheDocument();
  });

  it('disables changes while offline', async () => {
    render(<SecurityTab activeProperty={PROPERTY} isOffline />);
    expect(await screen.findByRole('button', { name: /turn off verification code/i })).toBeDisabled();
  });

  it('asks for a property when none is active', () => {
    render(<SecurityTab activeProperty={null} />);
    expect(screen.getByText(/choose a property/i)).toBeInTheDocument();
  });
});
