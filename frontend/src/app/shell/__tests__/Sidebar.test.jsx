import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '../Sidebar.jsx';

const user = { name: 'Emily Smith', role: 'Manager' };

// Representative example data, not PRODUCT_REQUIREMENTS.md's literal nav
// taxonomy — see nav-config.js's header for why the real one carries no
// requiredPermission. This is the same "prove the mechanism with synthetic
// data" approach tests/auth/rbac.test.js uses on the backend.
const navGroups = [
  {
    label: 'MAIN',
    items: [
      { key: 'front-desk', label: 'Front Desk' },
      { key: 'cashiering', label: 'Cashiering', requiredPermission: 'cashiering.post_charge' },
      { key: 'housekeeping', label: 'Housekeeping', requiredPermission: 'housekeeping.manage' },
    ],
  },
];

describe('<Sidebar>', () => {
  it('renders items with no requiredPermission for anyone', () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} />);
    expect(screen.getByText('Front Desk')).toBeInTheDocument();
  });

  it('filters out an item a role has no permission for — TESTING.md FE-5, "Housekeeper sees no Cashiering item"', () => {
    render(<Sidebar user={{ ...user, role: 'Housekeeping' }} navGroups={navGroups} permissions={new Set(['housekeeping.manage'])} />);
    expect(screen.getByRole('button', { name: 'Housekeeping' })).toBeInTheDocument();
    expect(screen.queryByText('Cashiering')).not.toBeInTheDocument();
  });

  it('does not just visually hide a filtered item — it is absent from the DOM entirely', () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} />);
    expect(document.body.innerHTML).not.toContain('Cashiering');
  });

  it('shows every item for a role holding every permission', () => {
    render(
      <Sidebar
        user={{ ...user, role: 'Admin' }}
        navGroups={navGroups}
        permissions={new Set(['cashiering.post_charge', 'housekeeping.manage'])}
      />
    );
    expect(screen.getByText('Front Desk')).toBeInTheDocument();
    expect(screen.getByText('Cashiering')).toBeInTheDocument();
    expect(screen.getByText('Housekeeping')).toBeInTheDocument();
  });

  it('drops an entire group when every one of its items is filtered out', () => {
    const groups = [{ label: 'MONEY', items: [{ key: 'ar', label: 'AR', requiredPermission: 'ar.view' }] }];
    render(<Sidebar user={user} navGroups={groups} permissions={new Set()} />);
    expect(screen.queryByText('MONEY')).not.toBeInTheDocument();
  });

  it('marks the active item with aria-current, and highlights it (DESIGN_SYSTEM.md §1: tinted pill, not just bold)', () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} activeItemKey="front-desk" />);
    const active = screen.getByRole('button', { name: 'Front Desk' });
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  it('calls onNavigate with the item key', async () => {
    const onNavigate = vi.fn();
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Front Desk' }));
    expect(onNavigate).toHaveBeenCalledWith('front-desk');
  });

  it('shows the user panel with name and role label', () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} />);
    expect(screen.getByText('Emily Smith')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toBeInTheDocument();
  });

  it('hides text labels when collapsed to icon-only, but keeps items in the DOM (not filtered, just compact)', () => {
    const allPermissions = new Set(['cashiering.post_charge', 'housekeeping.manage']);
    render(<Sidebar user={user} navGroups={navGroups} permissions={allPermissions} collapsed />);
    expect(screen.queryByText('Front Desk')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it("shows LodgeKeep's own platform mark, never a tenant logo — properties.logo_url is a separate concept", () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} />);
    expect(screen.getByAltText('LodgeKeep')).toBeInTheDocument();
    expect(screen.getByText('LodgeKeep')).toBeInTheDocument();
  });

  it('keeps the brand icon but hides the wordmark text when collapsed', () => {
    render(<Sidebar user={user} navGroups={navGroups} permissions={new Set()} collapsed />);
    expect(screen.getByAltText('LodgeKeep')).toBeInTheDocument();
    expect(screen.queryByText('LodgeKeep')).not.toBeInTheDocument();
  });
});
