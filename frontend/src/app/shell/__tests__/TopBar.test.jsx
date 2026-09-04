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
});
