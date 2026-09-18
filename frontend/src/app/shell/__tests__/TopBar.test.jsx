import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopBar } from '../TopBar.jsx';

const baseProps = {
  onToggleSidebar: () => {},
  user: { name: 'Emily Smith' },
  activeProperty: { id: '1', name: 'Alpha Hotels — Lagos' },
  properties: [{ id: '1', name: 'Alpha Hotels — Lagos' }],
  onSwitchProperty: () => {},
  businessDate: '2026-03-14',
};

describe('<TopBar>', () => {
  it('calls onToggleSidebar from the hamburger', async () => {
    const onToggleSidebar = vi.fn();
    render(<TopBar {...baseProps} onToggleSidebar={onToggleSidebar} />);
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it('shows the business date persistently', () => {
    render(<TopBar {...baseProps} />);
    expect(screen.getByText('Mar 14, 2026')).toBeInTheDocument();
  });

  it('shows the current property (PRODUCT_REQUIREMENTS.md: "must always be visible")', () => {
    render(<TopBar {...baseProps} />);
    expect(screen.getByText('Alpha Hotels — Lagos')).toBeInTheDocument();
  });

  it('shows the unread notification count', () => {
    render(<TopBar {...baseProps} notificationCount={7} />);
    expect(screen.getByLabelText('Notifications, 7 unread')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('shows no unread badge when the count is zero', () => {
    render(<TopBar {...baseProps} notificationCount={0} />);
    expect(screen.getByLabelText('Notifications')).toBeInTheDocument();
  });

  it('shows the user name', () => {
    render(<TopBar {...baseProps} />);
    expect(screen.getByText('Emily Smith')).toBeInTheDocument();
  });

  it('every icon control is a real, labelled, focusable button (44px touch target via --control-h-touch)', () => {
    render(<TopBar {...baseProps} onToggleFullscreen={() => {}} />);
    ['Toggle sidebar', 'Toggle fullscreen'].forEach((label) => {
      const button = screen.getByRole('button', { name: label });
      expect(button.tagName).toBe('BUTTON');
    });
  });

  it('renders the user chip as a plain, non-interactive element with no onLogout', () => {
    render(<TopBar {...baseProps} />);
    expect(screen.queryByRole('button', { name: /Emily Smith/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('opens a user menu with a Log out item when onLogout is supplied, and calls it on click', async () => {
    const onLogout = vi.fn();
    render(<TopBar {...baseProps} user={{ name: 'Emily Smith', role: 'manager' }} onLogout={onLogout} />);

    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Emily Smith/ }));
    const logoutItem = screen.getByRole('menuitem', { name: 'Log out' });
    expect(logoutItem).toBeInTheDocument();

    await userEvent.click(logoutItem);
    expect(onLogout).toHaveBeenCalled();
  });

  it('closes the user menu on Escape without calling onLogout', async () => {
    const onLogout = vi.fn();
    render(<TopBar {...baseProps} onLogout={onLogout} />);
    await userEvent.click(screen.getByRole('button', { name: /Emily Smith/ }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
    expect(onLogout).not.toHaveBeenCalled();
  });

  // Self-service "My Profile" screen (user-requested).
  it('renders a "My Profile" menu item above "Log out" when onOpenProfile is supplied, and calls it on click', async () => {
    const onLogout = vi.fn();
    const onOpenProfile = vi.fn();
    render(<TopBar {...baseProps} onLogout={onLogout} onOpenProfile={onOpenProfile} />);

    await userEvent.click(screen.getByRole('button', { name: /Emily Smith/ }));
    const profileItem = screen.getByRole('menuitem', { name: 'My Profile' });
    expect(profileItem).toBeInTheDocument();

    await userEvent.click(profileItem);
    expect(onOpenProfile).toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    // Clicking it closes the menu, same as Log out does.
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('does not render "My Profile" when onOpenProfile is not supplied', async () => {
    render(<TopBar {...baseProps} onLogout={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Emily Smith/ }));
    expect(screen.queryByRole('menuitem', { name: 'My Profile' })).not.toBeInTheDocument();
  });
  describe('notification bell', () => {
    const notifications = [
      {
        id: '1',
        type: 'guest.checked_in',
        payload: { guestName: 'Ada Obi', roomNumber: '204' },
        read_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: '2',
        type: 'room.became_dirty',
        payload: JSON.stringify({ roomNumber: '07', reason: 'check_out' }),
        read_at: '2026-09-13T10:00:00Z',
        created_at: new Date().toISOString(),
      },
    ];

    it('lists readable notifications with an unread marker', async () => {
      render(<TopBar {...baseProps} notificationCount={1} notifications={notifications} />);
      await userEvent.click(screen.getByLabelText('Notifications, 1 unread'));
      expect(screen.getByText('Checked in — Ada Obi')).toBeInTheDocument();
      expect(screen.getByText('Room 204')).toBeInTheDocument();
      expect(screen.getByText('Room 07 needs cleaning')).toBeInTheDocument();
    });

    it('marks all read, and hides that action when nothing is unread', async () => {
      const onMarkAllNotificationsRead = vi.fn();
      const { rerender } = render(
        <TopBar {...baseProps} notificationCount={1} notifications={notifications} onMarkAllNotificationsRead={onMarkAllNotificationsRead} />
      );
      await userEvent.click(screen.getByLabelText('Notifications, 1 unread'));
      await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      expect(onMarkAllNotificationsRead).toHaveBeenCalled();

      rerender(<TopBar {...baseProps} notificationCount={0} notifications={notifications} onMarkAllNotificationsRead={onMarkAllNotificationsRead} />);
      expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    });

    it('opens a notification and closes the panel', async () => {
      const onOpenNotification = vi.fn();
      render(<TopBar {...baseProps} notificationCount={1} notifications={notifications} onOpenNotification={onOpenNotification} />);
      await userEvent.click(screen.getByLabelText('Notifications, 1 unread'));
      await userEvent.click(screen.getByRole('menuitem', { name: /Checked in — Ada Obi/ }));
      expect(onOpenNotification).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
      expect(screen.queryByText('Checked in — Ada Obi')).not.toBeInTheDocument();
    });

    it('marks one notification read without opening it', async () => {
      const onMarkNotificationRead = vi.fn();
      const onOpenNotification = vi.fn();
      render(
        <TopBar
          {...baseProps}
          notificationCount={1}
          notifications={notifications}
          onMarkNotificationRead={onMarkNotificationRead}
          onOpenNotification={onOpenNotification}
        />
      );
      await userEvent.click(screen.getByLabelText('Notifications, 1 unread'));
      await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));
      expect(onMarkNotificationRead).toHaveBeenCalledWith('1');
      expect(onOpenNotification).not.toHaveBeenCalled();
    });
  });
});
