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
  setUserOutlets: vi.fn(),
  listOutlets: vi.fn(),
  getEmailDeliveryStatus: vi.fn(),
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
      setUserOutlets: mocks.setUserOutlets,
    },
    posApi: { listOutlets: mocks.listOutlets },
    setupApi: { ...actual.setupApi, getEmailDeliveryStatus: mocks.getEmailDeliveryStatus },
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
    mocks.getEmailDeliveryStatus.mockResolvedValue({ sendsEmail: true, source: 'property' });
    mocks.listOutlets.mockResolvedValue([]);
  });

  describe('staff outlets', () => {
    const OUTLETS = [
      { id: '1', name: 'Main Bar', type: 'bar' },
      { id: '2', name: 'Pool Bar', type: 'poolside' },
      { id: '3', name: 'Main Store', type: 'store' },
    ];
    const BARMAN = { ...USER, id: '7', email: 'bar@example.com', role: 'pos_operator', outlet_ids: ['1'] };
    const FLOATER = { ...USER, id: '8', email: 'float@example.com', role: 'pos_operator', outlet_ids: [] };

    beforeEach(() => {
      mocks.listOutlets.mockResolvedValue(OUTLETS);
      mocks.listUsers.mockResolvedValue([{ ...USER, outlet_ids: ['1'] }, BARMAN, FLOATER]);
      mocks.listPendingInvitations.mockResolvedValue([]);
    });

    it('shows who works where — and that managers always cover every outlet', async () => {
      render(<UsersTab />);
      expect(await screen.findByText('Main Bar')).toBeInTheDocument(); // the barman
      expect(screen.getByText('All outlets')).toBeInTheDocument(); // unassigned
      expect(screen.getByText('All outlets (role)')).toBeInTheDocument(); // the manager, assignment or not
      expect(screen.queryByRole('button', { name: 'Outlets for manager@example.com' })).not.toBeInTheDocument();
    });

    it('ticks outlets for a staff member and saves them', async () => {
      mocks.setUserOutlets.mockResolvedValue({});
      render(<UsersTab />);
      await userEvent.click(await screen.findByRole('button', { name: 'Outlets for bar@example.com' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('They will only be able to request stock for these outlets');
      await userEvent.click(screen.getByRole('checkbox', { name: 'Pool Bar' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save outlets' }));
      expect(mocks.setUserOutlets).toHaveBeenCalledWith('7', ['1', '2']);
      expect(mocks.listUsers).toHaveBeenCalledTimes(2); // refreshed after saving
    });

    it('unticking everything saves "every outlet"', async () => {
      mocks.setUserOutlets.mockResolvedValue({});
      render(<UsersTab />);
      await userEvent.click(await screen.findByRole('button', { name: 'Outlets for bar@example.com' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Main Bar' }));
      expect(screen.getByRole('alertdialog')).toHaveTextContent('they cover every outlet');
      await userEvent.click(screen.getByRole('button', { name: 'Save outlets' }));
      expect(mocks.setUserOutlets).toHaveBeenCalledWith('7', []);
    });

    it('shows the server’s refusal', async () => {
      mocks.setUserOutlets.mockRejectedValue(new ApiError({ status: 400, code: 'VALIDATION_OUTLET_NOT_FOUND', message: 'One of the chosen outlets does not exist or is archived.' }));
      render(<UsersTab />);
      await userEvent.click(await screen.findByRole('button', { name: 'Outlets for float@example.com' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Main Store (store)' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save outlets' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('does not exist or is archived');
    });

    it('has no Outlets column or action when outlets cannot be read', async () => {
      mocks.listOutlets.mockRejectedValue(new ApiError({ status: 403, code: 'FORBIDDEN_PERMISSION', message: 'no' }));
      render(<UsersTab />);
      expect(await screen.findByText('bar@example.com')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Outlets for/ })).not.toBeInTheDocument();
    });
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

  it('warns before inviting when this property has no mailbox', async () => {
    mocks.getEmailDeliveryStatus.mockResolvedValue({ sendsEmail: false, source: 'none' });
    mocks.listUsers.mockResolvedValue([]);
    mocks.listPendingInvitations.mockResolvedValue([]);
    render(<UsersTab disabled={false} />);
    expect(await screen.findByText('Emails from this property are not being sent.')).toBeInTheDocument();
    expect(screen.getByText(/invitation from this property will not reach/i)).toBeInTheDocument();
  });

  it('says the invitation email was not sent, instead of "sent", when the property has no mailbox', async () => {
    mocks.listUsers.mockResolvedValue([]);
    mocks.listPendingInvitations.mockResolvedValue([]);
    mocks.inviteUser.mockResolvedValue({ id: '9', email: 'new@example.com', email_delivery: { sendsEmail: false, source: 'none' } });
    render(<UsersTab disabled={false} />);
    await screen.findByText(/no users at this property yet/i);

    await userEvent.type(screen.getByPlaceholderText('new.hire@example.com'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText(/invitation created for new@example.com, but no email was sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/invitation sent to/i)).not.toBeInTheDocument();
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
