import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsTab } from '../NotificationsTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getNotificationCatalogue: vi.fn(),
  getNotificationRoleRules: vi.fn(),
  saveNotificationRoleRules: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, notificationsApi: mocks };
});

const CATALOGUE = [
  {
    eventType: 'qr_ordering.guest_order_placed',
    group: 'POS & QR orders',
    label: 'New guest QR order',
    description: 'A guest QR order is paid.',
    defaultRoles: ['pos_operator', 'manager', 'super_admin'],
  },
  {
    eventType: 'room.became_dirty',
    group: 'Housekeeping',
    label: 'Room needs cleaning',
    description: 'A room was vacated.',
    defaultRoles: ['housekeeping', 'manager'],
  },
];

describe('<NotificationsTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getNotificationCatalogue.mockResolvedValue(CATALOGUE);
    mocks.getNotificationRoleRules.mockResolvedValue([]);
  });

  it('asks for a property first', () => {
    render(<NotificationsTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('checks each role that receives a type by default, grouped by area', async () => {
    render(<NotificationsTab disabled={false} />);
    expect(await screen.findByRole('checkbox', { name: 'New guest QR order: POS operator' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'New guest QR order: Super admin' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'New guest QR order: Front desk' })).not.toBeChecked();
    expect(screen.getByRole('columnheader', { name: 'POS & QR orders' })).toBeInTheDocument();
    // "Housekeeping" is both a group heading and a role column.
    expect(screen.getAllByRole('columnheader', { name: 'Housekeeping' })).toHaveLength(2);
  });

  it('applies saved overrides on top of the defaults', async () => {
    mocks.getNotificationRoleRules.mockResolvedValue([
      { eventType: 'qr_ordering.guest_order_placed', role: 'super_admin', enabled: false },
      { eventType: 'room.became_dirty', role: 'front_desk', enabled: true },
    ]);
    render(<NotificationsTab disabled={false} />);
    expect(await screen.findByRole('checkbox', { name: 'New guest QR order: Super admin' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Room needs cleaning: Front desk' })).toBeChecked();
  });

  it('saves the full grid and confirms', async () => {
    mocks.saveNotificationRoleRules.mockImplementation(async (rules) => rules);
    render(<NotificationsTab disabled={false} />);
    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Room needs cleaning: Front desk' }));
    await userEvent.click(save);

    const rules = mocks.saveNotificationRoleRules.mock.calls[0][0];
    expect(rules).toHaveLength(14);
    expect(rules).toContainEqual({ eventType: 'room.became_dirty', role: 'front_desk', enabled: true });
    expect(rules).toContainEqual({ eventType: 'room.became_dirty', role: 'cashier', enabled: false });
    expect(await screen.findByText('Notification settings saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('shows the real error when saving is refused', async () => {
    mocks.saveNotificationRoleRules.mockRejectedValue(
      new ApiError({ status: 403, code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to do that.' })
    );
    render(<NotificationsTab disabled={false} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Room needs cleaning: Cashier' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
  });

  it('discards unsaved changes and restores defaults', async () => {
    mocks.getNotificationRoleRules.mockResolvedValue([{ eventType: 'room.became_dirty', role: 'cashier', enabled: true }]);
    render(<NotificationsTab disabled={false} />);
    const cashier = await screen.findByRole('checkbox', { name: 'Room needs cleaning: Cashier' });
    expect(cashier).toBeChecked();

    await userEvent.click(cashier);
    expect(cashier).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(cashier).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(cashier).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeDisabled();
  });

  it('disables saving while offline', async () => {
    render(<NotificationsTab disabled={false} isOffline />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Room needs cleaning: Cashier' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
  });

  it('shows a load failure with a retry', async () => {
    mocks.getNotificationCatalogue.mockRejectedValueOnce(new ApiError({ status: 403, code: 'FORBIDDEN_PERMISSION', message: 'Not allowed.' }));
    render(<NotificationsTab disabled={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('checkbox', { name: 'Room needs cleaning: Cashier' })).toBeInTheDocument();
  });
});
