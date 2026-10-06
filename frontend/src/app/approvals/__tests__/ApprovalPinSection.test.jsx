import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyAccountModal } from '../../account/MyAccountModal.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ getMyApprovalPin: vi.fn(), setMyApprovalPin: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, approvalsApi: mocks };
});

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    getMyProfile: vi.fn(async () => ({ firstName: 'Grace', lastName: 'Manager', email: 'grace@example.com', phone: null })),
    updateProfile: vi.fn(),
    changeMyPassword: vi.fn(),
  }),
}));

async function pinSection() {
  return screen.findByRole('heading', { name: 'Approval PIN' });
}

describe('Approval PIN (My Profile)', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('is shown only to someone who can approve', async () => {
    mocks.getMyApprovalPin.mockResolvedValue({ has_pin: false, set_at: null, locked_until: null });
    const { unmount } = render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Change password' });
    expect(screen.queryByRole('heading', { name: 'Approval PIN' })).not.toBeInTheDocument();
    expect(mocks.getMyApprovalPin).not.toHaveBeenCalled();
    unmount();

    render(<MyAccountModal canApprove onClose={vi.fn()} />);
    expect(await pinSection()).toBeInTheDocument();
    expect(await screen.findByText('You have not set an approval PIN yet.')).toBeInTheDocument();
  });

  it('sets a PIN with the current password, only once the two PINs match, and never shows it back', async () => {
    mocks.getMyApprovalPin.mockResolvedValue({ has_pin: false, set_at: null, locked_until: null });
    mocks.setMyApprovalPin.mockResolvedValue({ has_pin: true, set_at: '2027-08-10T10:00:00Z' });
    render(<MyAccountModal canApprove onClose={vi.fn()} />);
    await pinSection();
    const setButton = await screen.findByRole('button', { name: 'Set PIN' });

    await userEvent.type(screen.getAllByLabelText('Current password')[1], 'correct horse battery staple');
    await userEvent.type(screen.getByLabelText('New PIN (6 digits)'), '73x0194');
    await userEvent.type(screen.getByLabelText('Confirm PIN'), '730195');
    expect(screen.getByLabelText('New PIN (6 digits)')).toHaveValue('730194');
    expect(screen.getByText('The two PINs don’t match.')).toBeInTheDocument();
    expect(setButton).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Confirm PIN'));
    await userEvent.type(screen.getByLabelText('Confirm PIN'), '730194');
    await userEvent.click(setButton);

    expect(mocks.setMyApprovalPin).toHaveBeenCalledWith({ currentPassword: 'correct horse battery staple', pin: '730194' });
    expect(await screen.findByText('Approval PIN saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('New PIN (6 digits)')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Change PIN' })).toBeInTheDocument();
  });

  it('shows the server refusal (e.g. a too-simple PIN) and a locked PIN', async () => {
    mocks.getMyApprovalPin.mockResolvedValue({ has_pin: true, set_at: '2027-08-01T10:00:00Z', locked_until: '2027-08-10T10:15:00Z' });
    mocks.setMyApprovalPin.mockRejectedValue(new ApiError({ code: 'VALIDATION_APPROVAL_PIN_TOO_SIMPLE', message: 'Choose a PIN that is not one digit repeated or a straight run like 123456.', status: 400 }));
    render(<MyAccountModal canApprove onClose={vi.fn()} />);
    expect(await screen.findByText(/Your PIN is locked/)).toBeInTheDocument();
    await userEvent.type(screen.getAllByLabelText('Current password')[1], 'pw');
    await userEvent.type(screen.getByLabelText('New PIN (6 digits)'), '123456');
    await userEvent.type(screen.getByLabelText('Confirm PIN'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Change PIN' }));
    expect(await screen.findByText(/not one digit repeated/)).toBeInTheDocument();
  });

  it('cannot save while offline', async () => {
    mocks.getMyApprovalPin.mockResolvedValue({ has_pin: false, set_at: null, locked_until: null });
    render(<MyAccountModal canApprove isOffline onClose={vi.fn()} />);
    await pinSection();
    await userEvent.type(screen.getAllByLabelText('Current password')[1], 'pw');
    await userEvent.type(screen.getByLabelText('New PIN (6 digits)'), '730194');
    await userEvent.type(screen.getByLabelText('Confirm PIN'), '730194');
    expect(screen.getByRole('button', { name: 'Set PIN' })).toBeDisabled();
  });
});
