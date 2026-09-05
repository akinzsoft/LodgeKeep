import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersTab } from '../UsersTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listPendingInvitations: vi.fn(),
  inviteUser: vi.fn(),
  deactivateUser: vi.fn(),
  changeUserRole: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    usersApi: {
      listUsers: mocks.listUsers,
      listPendingInvitations: mocks.listPendingInvitations,
      inviteUser: mocks.inviteUser,
      deactivateUser: mocks.deactivateUser,
      changeUserRole: mocks.changeUserRole,
    },
  };
});

const USER = {
  id: '1',
  email: 'manager@example.com',
  first_name: 'Man',
  last_name: 'Ager',
  role: 'manager',
  status: 'active',
  last_login_at: null,
};

describe('<UsersTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows a disabled notice with no active property, and never calls the API', () => {
    render(<UsersTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it('lists users, showing "Never" for a null last login', async () => {
    mocks.listUsers.mockResolvedValue([USER]);
    mocks.listPendingInvitations.mockResolvedValue([]);
    render(<UsersTab disabled={false} />);
    expect(await screen.findByText('manager@example.com')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('invites a user and shows the dev-only token', async () => {
    mocks.listUsers.mockResolvedValue([]);
    mocks.listPendingInvitations.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: '9', email: 'new@example.com', role: 'front_desk', status: 'pending', expires_at: '2027-01-01' },
    ]);
    mocks.inviteUser.mockResolvedValue({ id: '9', email: 'new@example.com', dev_only_token: 'dev-token-123' });
    render(<UsersTab disabled={false} />);
    await screen.findByText(/no users at this property yet/i);

    await userEvent.type(screen.getByPlaceholderText('new.hire@example.com'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(mocks.inviteUser).toHaveBeenCalledWith({ email: 'new@example.com', role: 'front_desk' });
    expect(await screen.findByText(/invitation sent to new@example.com/i)).toBeInTheDocument();
    expect(screen.getByText('dev-token-123')).toBeInTheDocument();
  });

  it('deactivates a user after confirming', async () => {
    mocks.listUsers.mockResolvedValueOnce([USER]).mockResolvedValueOnce([{ ...USER, status: 'inactive' }]);
    mocks.listPendingInvitations.mockResolvedValue([]);
    mocks.deactivateUser.mockResolvedValue({ ...USER, status: 'inactive' });
    render(<UsersTab disabled={false} />);
    await screen.findByText('manager@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText(/immediately revokes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deactivation' }));

    expect(mocks.deactivateUser).toHaveBeenCalledWith('1');
  });

  it('shows the backend error message on a failed invite', async () => {
    mocks.listUsers.mockResolvedValue([]);
    mocks.listPendingInvitations.mockResolvedValue([]);
    mocks.inviteUser.mockRejectedValue(new ApiError({ code: 'VALIDATION_ROLE_NOT_FOUND', message: '"bogus" is not a valid role for this tenant.' }));
    render(<UsersTab disabled={false} />);
    await screen.findByText(/no users at this property yet/i);

    await userEvent.type(screen.getByPlaceholderText('new.hire@example.com'), 'x@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid role');
  });
});
