import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImpersonatedStaffView } from '../ImpersonatedStaffView.jsx';

vi.mock('../auth/PlatformAuthContext.jsx', () => ({ usePlatformAuth: () => ({
  impersonation: { tenantName: 'Chain', propertyId: '20' }, exitImpersonation: vi.fn(),
}) }));
vi.mock('../../shared/api/setup.js', () => ({ listProperties: vi.fn().mockResolvedValue([
  { id: '20', name: 'Riverside Lodge', current_business_date: '2026-08-31', base_currency: 'NGN' },
]) }));
vi.mock('../../app/dashboard/HomeDashboard.jsx', () => ({
  HomeDashboard: ({ businessDate, activeProperty }) => (
    <p>
      Dashboard date: {businessDate} · currency {activeProperty?.base_currency ?? 'none'}
    </p>
  ),
}));
// User-reported: POS under impersonation said "Choose a property" although
// the top bar showed one. Stand-ins that print the property they are given.
vi.mock('../../app/pos/POSScreen.jsx', () => ({
  POSScreen: ({ activeProperty }) => <p>POS for {activeProperty ? `${activeProperty.name} (${activeProperty.base_currency})` : 'no property'}</p>,
}));
vi.mock('../../app/staff/StaffScreen.jsx', () => ({
  StaffScreen: ({ activeProperty }) => <p>Staff for {activeProperty?.name ?? 'no property'}</p>,
}));

describe('impersonated property context', () => {
  it('uses the property name and business date and responds to connectivity changes', async () => {
    render(<ImpersonatedStaffView />);
    // Shown in the top bar's property switcher and at the top of the sidebar.
    expect((await screen.findAllByText('Riverside Lodge')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Dashboard date: 2026-08-31 · currency NGN')).toBeInTheDocument();
    fireEvent(window, new Event('offline'));
    expect(screen.getByText(/You’re offline|You are offline|You.re offline/i)).toBeInTheDocument();
    fireEvent(window, new Event('online'));
  });

  it('gives POS the impersonated property, so it opens instead of asking to choose one', async () => {
    render(<ImpersonatedStaffView />);
    await screen.findAllByText('Riverside Lodge');
    fireEvent.click(screen.getByRole('button', { name: 'POS' }));
    expect(await screen.findByText('POS for Riverside Lodge (NGN)')).toBeInTheDocument();
  });

  it('opens the Staff screen from its nav item instead of falling back to Home', async () => {
    render(<ImpersonatedStaffView />);
    await screen.findAllByText('Riverside Lodge');
    fireEvent.click(screen.getByRole('button', { name: 'Staff' }));
    expect(await screen.findByText('Staff for Riverside Lodge')).toBeInTheDocument();
  });
});
