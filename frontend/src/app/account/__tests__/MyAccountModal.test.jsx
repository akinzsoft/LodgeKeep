import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyAccountModal } from '../MyAccountModal.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  updateProfile: vi.fn(),
  changeMyPassword: vi.fn(),
}));

vi.mock('../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({
    getMyProfile: mocks.getMyProfile,
    updateProfile: mocks.updateProfile,
    changeMyPassword: mocks.changeMyPassword,
  }),
}));

const REAL_PROFILE = { userId: '1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Okafor', phone: '+2348012345678' };

describe('<MyAccountModal>', () => {
  beforeEach(() => {
    mocks.getMyProfile.mockReset().mockResolvedValue(REAL_PROFILE);
    mocks.updateProfile.mockReset();
    mocks.changeMyPassword.mockReset();
  });

  it('shows a loading state, then resolves to a pre-filled form with Email as plain read-only text', async () => {
    render(<MyAccountModal onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Okafor')).toBeInTheDocument();
    expect(screen.getByDisplayValue('+2348012345678')).toBeInTheDocument();

    // Email renders as plain text, never an editable field of any kind.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument();
  });

  it('a load failure shows the real error with a retry that succeeds', async () => {
    mocks.getMyProfile.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'Something went wrong loading your profile.' }));
    render(<MyAccountModal onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong loading your profile.');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
  });

  it('editing and saving calls updateProfile with the right payload and shows the real updated values', async () => {
    mocks.updateProfile.mockResolvedValue({ ...REAL_PROFILE, firstName: 'Adaeze', lastName: 'Nwosu', phone: '+2348099999999' });
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.clear(screen.getByDisplayValue('Ada'));
    await userEvent.type(screen.getByLabelText('First name'), 'Adaeze');
    await userEvent.clear(screen.getByDisplayValue('Okafor'));
    await userEvent.type(screen.getByLabelText('Last name'), 'Nwosu');
    await userEvent.clear(screen.getByDisplayValue('+2348012345678'));
    await userEvent.type(screen.getByLabelText('Phone'), '+2348099999999');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateProfile).toHaveBeenCalledWith({ firstName: 'Adaeze', lastName: 'Nwosu', phone: '+2348099999999' })
    );
    expect(await screen.findByDisplayValue('Adaeze')).toBeInTheDocument();
    expect(screen.getByText('Saved.')).toBeInTheDocument();
  });

  it('an empty phone is sent as null, not an empty string', async () => {
    mocks.updateProfile.mockResolvedValue({ ...REAL_PROFILE, phone: null });
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.clear(screen.getByDisplayValue('+2348012345678'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ firstName: 'Ada', lastName: 'Okafor', phone: null }));
  });

  it('a validation error from the backend renders verbatim', async () => {
    mocks.updateProfile.mockRejectedValue(new ApiError({ code: 'VALIDATION_FIRST_NAME_TOO_LONG', message: 'First name must be 100 characters or fewer.' }));
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('First name must be 100 characters or fewer.');
  });

  it("the password section's Confirm mismatch blocks submission client-side, with no network call", async () => {
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.type(screen.getByLabelText('Current password'), 'the original strong passphrase');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a totally different passphrase');

    expect(screen.getByText('New password and confirmation don’t match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
    expect(mocks.changeMyPassword).not.toHaveBeenCalled();
  });

  it('a successful password change shows the "other sessions" message, pluralized correctly', async () => {
    mocks.changeMyPassword.mockResolvedValue({ status: 'ok', otherSessionsRevoked: 3 });
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.type(screen.getByLabelText('Current password'), 'the original strong passphrase');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('(3 other sessions)');
    expect(mocks.changeMyPassword).toHaveBeenCalledWith({ currentPassword: 'the original strong passphrase', newPassword: 'a brand new strong passphrase' });
  });

  it('singular "1 other session" is not pluralized', async () => {
    mocks.changeMyPassword.mockResolvedValue({ status: 'ok', otherSessionsRevoked: 1 });
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.type(screen.getByLabelText('Current password'), 'the original strong passphrase');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('(1 other session)');
  });

  it('omits the parenthetical entirely when otherSessionsRevoked is 0', async () => {
    mocks.changeMyPassword.mockResolvedValue({ status: 'ok', otherSessionsRevoked: 0 });
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.type(screen.getByLabelText('Current password'), 'the original strong passphrase');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Password changed.');
    expect(status).not.toHaveTextContent('other session');
  });

  it('a wrong-current-password error renders verbatim', async () => {
    mocks.changeMyPassword.mockRejectedValue(new ApiError({ code: 'VALIDATION_CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect.' }));
    render(<MyAccountModal onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.type(screen.getByLabelText('Current password'), 'wrong one');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new strong passphrase');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect.');
  });

  it('both forms disable their submit buttons while offline', async () => {
    render(<MyAccountModal isOffline onClose={vi.fn()} />);
    await screen.findByDisplayValue('Ada');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(<MyAccountModal onClose={onClose} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('a backdrop click calls onClose, but clicking inside the dialog does not', async () => {
    const onClose = vi.fn();
    render(<MyAccountModal onClose={onClose} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalled();
  });

  it('the close (×) button calls onClose', async () => {
    const onClose = vi.fn();
    render(<MyAccountModal onClose={onClose} />);
    await screen.findByDisplayValue('Ada');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
