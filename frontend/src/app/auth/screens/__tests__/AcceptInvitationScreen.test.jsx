import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AcceptInvitationScreen } from '../AcceptInvitationScreen.jsx';
import { ApiError } from '../../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ acceptInvitation: vi.fn() }));

vi.mock('../../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../../shared/api/index.js');
  return {
    ...actual,
    authApi: { acceptInvitation: mocks.acceptInvitation },
  };
});

describe('<AcceptInvitationScreen>', () => {
  beforeEach(() => {
    mocks.acceptInvitation.mockReset();
  });

  it('submits the form and shows a success state without auto-logging in', async () => {
    mocks.acceptInvitation.mockResolvedValue({ status: 'ok' });
    render(<AcceptInvitationScreen token="a-real-token" />);

    await userEvent.type(screen.getByLabelText(/first name/i), 'New');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hire');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(mocks.acceptInvitation).toHaveBeenCalledWith({
      token: 'a-real-token',
      firstName: 'New',
      lastName: 'Hire',
      password: 'a brand new strong passphrase',
    });
    expect(await screen.findByText(/account is ready/i)).toBeInTheDocument();
  });

  it('shows the backend error message on an invalid or expired token', async () => {
    mocks.acceptInvitation.mockRejectedValue(new ApiError({ code: 'AUTH_TOKEN_INVALID', message: 'This link is invalid or has expired.' }));
    render(<AcceptInvitationScreen token="bad-token" />);

    await userEvent.type(screen.getByLabelText(/first name/i), 'New');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hire');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a brand new strong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has expired');
  });

  it('disables submission while offline', () => {
    render(<AcceptInvitationScreen token="a-real-token" isOffline />);
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });
});
