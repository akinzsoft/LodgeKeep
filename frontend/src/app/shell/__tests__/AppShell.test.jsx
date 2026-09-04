import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../AppShell.jsx';

const baseProps = {
  user: { name: 'Emily Smith', role: 'Manager' },
  permissions: new Set(),
  activeProperty: { id: '1', name: 'Alpha Hotels — Lagos' },
  properties: [{ id: '1', name: 'Alpha Hotels — Lagos' }],
  onSwitchProperty: () => {},
  businessDate: '2026-03-14',
};

describe('<AppShell>', () => {
  it('renders the sidebar, top bar, and page content together', () => {
    render(
      <AppShell {...baseProps}>
        <p>Page content</p>
      </AppShell>
    );
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByText('Mar 14, 2026')).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it("uses PRODUCT_REQUIREMENTS.md's literal default nav taxonomy when the caller supplies none", () => {
    // 'Booking' is PLAN.md Phase 2's reservations module, gated on
    // reservations.view (nav-config.js) — granted here so this test can
    // assert the taxonomy itself; the gating mechanism has its own
    // dedicated test below.
    render(
      <AppShell {...baseProps} permissions={new Set(['reservations.view'])}>
        content
      </AppShell>
    );
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Booking' })).toBeInTheDocument();
  });

  it('toggling the hamburger collapses the sidebar (text labels disappear)', async () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('shows no impersonation banner by default', () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the impersonation banner when a grant is active, and it wires to onExit (SECURITY.md §2)', async () => {
    const onExit = vi.fn();
    render(
      <AppShell {...baseProps} impersonation={{ tenantName: 'Alpha Hotels', onExit }}>
        content
      </AppShell>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Alpha Hotels');
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));
    expect(onExit).toHaveBeenCalled();
  });

  it('shows no offline banner by default', () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it('shows the offline banner when isOffline is true (DESIGN_SYSTEM.md §2\'s sixth state)', () => {
    render(
      <AppShell {...baseProps} isOffline>
        content
      </AppShell>
    );
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it('filters nav items per the permissions passed through to Sidebar (TESTING.md FE-5)', () => {
    const navGroups = [
      { label: 'MAIN', items: [{ key: 'cashiering', label: 'Cashiering', requiredPermission: 'cashiering.post_charge' }] },
    ];
    render(
      <AppShell {...baseProps} navGroups={navGroups} permissions={new Set()}>
        content
      </AppShell>
    );
    expect(screen.queryByText('Cashiering')).not.toBeInTheDocument();
  });

  it('renders the "Powered by LodgeKeep" footer', () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.getByText('Powered by LodgeKeep')).toBeInTheDocument();
  });
});
