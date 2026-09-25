import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../AppShell.jsx';
import { stubViewport } from '../../../shared/hooks/__tests__/stubViewport.js';

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

  it('toggling the hamburger collapses the sidebar to icons — visible labels disappear, but each item keeps its accessible name', async () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.getByText('Home')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    // Icon-only items used to render with no name at all — unusable with a
    // screen reader and indistinguishable on hover.
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('title', 'Home');
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

  it('renders the "Powered by Planmsys" footer', () => {
    render(<AppShell {...baseProps}>content</AppShell>);
    expect(screen.getByText('Powered by Planmsys')).toBeInTheDocument();
  });

  /**
   * Gap closure (mobile/POS layout check). The sidebar used to start FULL WIDTH
   * on every screen. On a phone that meant an off-canvas drawer laid over the
   * page on first load (the user landed on the menu) that also stayed open after
   * a tap (two taps per navigation); on a portrait tablet a 240px sidebar left the
   * content too little room and the page overflowed sideways. DESIGN_SYSTEM.md §1:
   * "full → icon-only at 1024px → off-canvas drawer below 640px".
   */
  describe('the sidebar default follows the screen', () => {
    afterEach(() => {
      delete window.matchMedia;
    });

    const scrim = (container) => container.querySelector('[class*="scrim"]');
    const labelsShown = () => screen.queryByText('Home') !== null; // labels only render while the sidebar is expanded

    it('desktop: open, full width', () => {
      stubViewport('desktop');
      render(<AppShell {...baseProps}>content</AppShell>);
      expect(labelsShown()).toBe(true);
    });

    it('tablet / POS terminal: an icon-only rail, so the content keeps its room — the hamburger expands it', async () => {
      stubViewport('tablet');
      const { container } = render(<AppShell {...baseProps}>content</AppShell>);
      expect(labelsShown()).toBe(false);
      expect(scrim(container)).toBeNull();
      expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('title', 'Home'); // still reachable, still named
      await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
      expect(labelsShown()).toBe(true);
    });

    it('tablet: tapping a menu item navigates but leaves the sidebar as it was', async () => {
      stubViewport('tablet');
      const onNavigate = vi.fn();
      render(
        <AppShell {...baseProps} onNavigate={onNavigate}>
          content
        </AppShell>
      );
      await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' })); // expand it
      await userEvent.click(screen.getByRole('button', { name: 'Home' }));
      expect(onNavigate).toHaveBeenCalledWith('home');
      expect(labelsShown()).toBe(true);
    });

    describe('phone', () => {
      it('starts with the drawer CLOSED — no menu laid over the page, no dimming scrim', () => {
        stubViewport('phone');
        const { container } = render(<AppShell {...baseProps}>Page content</AppShell>);
        expect(scrim(container)).toBeNull();
        expect(labelsShown()).toBe(false);
        expect(screen.getByText('Page content')).toBeInTheDocument();
      });

      it('the hamburger opens the drawer, and the scrim taps it closed again', async () => {
        stubViewport('phone');
        const { container } = render(<AppShell {...baseProps}>content</AppShell>);
        await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
        expect(labelsShown()).toBe(true);
        expect(scrim(container)).not.toBeNull();
        await userEvent.click(scrim(container));
        expect(scrim(container)).toBeNull();
      });

      it('tapping a menu item navigates AND closes the drawer — one tap, not two', async () => {
        stubViewport('phone');
        const onNavigate = vi.fn();
        const { container } = render(
          <AppShell {...baseProps} onNavigate={onNavigate}>
            content
          </AppShell>
        );
        await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
        await userEvent.click(screen.getByRole('button', { name: 'Home' }));
        expect(onNavigate).toHaveBeenCalledWith('home');
        expect(scrim(container)).toBeNull();
        expect(labelsShown()).toBe(false);
      });
    });

    it('rotating or resizing across a breakpoint resets the sidebar to that screen\'s default', () => {
      const viewport = stubViewport('desktop');
      const { container } = render(<AppShell {...baseProps}>content</AppShell>);
      expect(labelsShown()).toBe(true); // desktop: open
      viewport.setTier('tablet');
      expect(labelsShown()).toBe(false); // tablet: icon rail
      viewport.setTier('phone');
      expect(scrim(container)).toBeNull(); // phone: drawer closed
      viewport.setTier('desktop');
      expect(labelsShown()).toBe(true); // back to open
    });
  });
});
