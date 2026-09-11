import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImpersonatedStaffView } from '../ImpersonatedStaffView.jsx';

vi.mock('../auth/PlatformAuthContext.jsx', () => ({ usePlatformAuth: () => ({
  impersonation: { tenantName: 'Chain', propertyId: '20' }, exitImpersonation: vi.fn(),
}) }));
vi.mock('../../shared/api/setup.js', () => ({ listProperties: vi.fn().mockResolvedValue([
  { id: '20', name: 'Riverside Lodge', current_business_date: '2026-08-31' },
]) }));
vi.mock('../../app/dashboard/HomeDashboard.jsx', () => ({ HomeDashboard: ({ businessDate }) => <p>Dashboard date: {businessDate}</p> }));

describe('impersonated property context', () => {
  it('uses the property name and business date and responds to connectivity changes', async () => {
    render(<ImpersonatedStaffView />);
    expect(await screen.findByText('Riverside Lodge')).toBeInTheDocument();
    expect(screen.getByText('Dashboard date: 2026-08-31')).toBeInTheDocument();
    fireEvent(window, new Event('offline'));
    expect(screen.getByText(/You’re offline|You are offline|You.re offline/i)).toBeInTheDocument();
    fireEvent(window, new Event('online'));
  });
});
