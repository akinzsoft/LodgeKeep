import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaffScreen } from '../StaffScreen.jsx';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listPendingInvitations: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    usersApi: {
      listUsers: mocks.listUsers,
      listPendingInvitations: mocks.listPendingInvitations,
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

/**
 * Gap closure (user-reported): the "Staff" nav item had no screen and
 * bounced to Home. It now mounts the real user-management UI.
 */
describe('<StaffScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listUsers.mockResolvedValue([USER]);
    mocks.listPendingInvitations.mockResolvedValue([]);
  });

  it('shows the Staff heading and lists the real staff', async () => {
    render(<StaffScreen activeProperty={{ id: '1', name: 'Fixture Hotel' }} />);
    expect(screen.getByRole('heading', { name: 'Staff' })).toBeInTheDocument();
    expect(await screen.findByText('manager@example.com')).toBeInTheDocument();
    expect(mocks.listUsers).toHaveBeenCalledTimes(1);
  });

  it('says a property is needed first, without calling the API, when none exists', async () => {
    render(<StaffScreen activeProperty={null} />);
    expect(await screen.findByText(/create a property first/i)).toBeInTheDocument();
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });
});
