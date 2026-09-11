import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider } from '../../auth/PlatformAuthContext.jsx';
import { TenantDetailScreen } from '../TenantDetailScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  getTenant: vi.fn(),
  listImpersonationSessionsForTenant: vi.fn(),
  startImpersonation: vi.fn(),
  suspendTenant: vi.fn(),
  reactivateTenant: vi.fn(),
  offboardTenant: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks }, configureApiClient: mocks.configureApiClient };
});

const TENANT = {
  id: '1',
  name: 'Acme Hotels',
  status: 'active',
  properties: [{ id: '20', name: 'Acme Main', slug: 'acme-main', status: 'active' }],
};
const SESSION = { id: '5', reason: 'Past support ticket', started_at: '2027-01-01', ended_at: '2027-01-01', platform_user: { email: 'ops@lodgekeep.test' } };

function renderScreen(props = {}) {
  return render(
    <PlatformAuthProvider>
      <TenantDetailScreen tenantId="1" onBack={vi.fn()} onLogout={vi.fn()} {...props} />
    </PlatformAuthProvider>
  );
}

describe('<TenantDetailScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getTenant.mockResolvedValue(TENANT);
    mocks.listImpersonationSessionsForTenant.mockResolvedValue([SESSION]);
  });

  it('shows the tenant name, its properties, and its real impersonation history', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Acme Hotels' })).toBeInTheDocument();
    // "Acme Main" also appears as a select <option> in the impersonate form.
    expect((await screen.findAllByText('Acme Main')).find((el) => el.tagName === 'TD')).toBeInTheDocument();
    expect(screen.getByText('Past support ticket')).toBeInTheDocument();
    expect(screen.getByText('ops@lodgekeep.test')).toBeInTheDocument();
  });

  it('starting impersonation requires a reason and a property, then calls the real endpoint', async () => {
    mocks.startImpersonation.mockResolvedValue({ accessToken: 'token', tenantId: '1', tenantName: 'Acme Hotels', propertyId: '20', impersonationSessionId: '9' });
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText('Reason (required, visible to the tenant)'), 'Debugging billing issue');
    await userEvent.click(screen.getByRole('button', { name: 'Start impersonation' }));

    expect(mocks.startImpersonation).toHaveBeenCalledWith('1', { propertyId: '20', reason: 'Debugging billing issue' });
  });

  it('surfaces a real backend error from starting impersonation', async () => {
    mocks.startImpersonation.mockRejectedValue(new ApiError({ code: 'VALIDATION_PROPERTY_NOT_IN_TENANT', message: 'The specified property does not belong to this tenant.' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText('Reason (required, visible to the tenant)'), 'Debugging billing issue');
    await userEvent.click(screen.getByRole('button', { name: 'Start impersonation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The specified property does not belong to this tenant.');
  });

  it('shows the real tenant status and a Suspend action for an active tenant', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Suspend tenant' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reactivate tenant' })).not.toBeInTheDocument();
  });

  it('suspending requires a reason and calls the real endpoint, then reloads the tenant', async () => {
    mocks.suspendTenant.mockResolvedValue({ tenantId: '1', status: 'suspended' });
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText('Reason (required, recorded on the audit trail)'), 'Payment failed');
    await userEvent.click(screen.getByRole('button', { name: 'Suspend tenant' }));

    expect(mocks.suspendTenant).toHaveBeenCalledWith('1', 'Payment failed');
    expect(mocks.getTenant).toHaveBeenCalledTimes(2); // once on mount, once after the action
  });

  it('surfaces a real backend error from suspending, e.g. a support-tier account refused', async () => {
    mocks.suspendTenant.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PLATFORM_ROLE', message: 'This action requires a higher platform-staff tier.' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText('Reason (required, recorded on the audit trail)'), 'Payment failed');
    await userEvent.click(screen.getByRole('button', { name: 'Suspend tenant' }));

    expect(await screen.findByText('This action requires a higher platform-staff tier.')).toBeInTheDocument();
  });

  it('shows a Reactivate action, not Suspend, for a suspended tenant', async () => {
    mocks.getTenant.mockResolvedValue({ ...TENANT, status: 'suspended' });
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    expect(screen.getByText('suspended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate tenant' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend tenant' })).not.toBeInTheDocument();

    mocks.reactivateTenant.mockResolvedValue({ tenantId: '1', status: 'active' });
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate tenant' }));
    expect(mocks.reactivateTenant).toHaveBeenCalledWith('1', '');
  });

  it('an active tenant also offers an Offboard action, which calls the real endpoint', async () => {
    mocks.offboardTenant.mockResolvedValue({ tenantId: '1', status: 'offboarding', exportId: '1' });
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText('Reason (recorded on the audit trail)'), 'Customer requested cancellation');
    await userEvent.click(screen.getByRole('button', { name: 'Offboard tenant' }));

    expect(mocks.offboardTenant).toHaveBeenCalledWith('1', 'Customer requested cancellation');
  });

  it('an offboarding tenant shows its retention info, a Reactivate action, and no Offboard action', async () => {
    mocks.getTenant.mockResolvedValue({
      ...TENANT,
      status: 'offboarding',
      offboarding_requested_at: '2026-09-11T00:00:00.000Z',
      retention_expires_at: '2026-10-11T00:00:00.000Z',
    });
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    expect(screen.getByText('offboarding')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-11T00:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByText(/2026-10-11T00:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate tenant' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Offboard tenant' })).not.toBeInTheDocument();

    mocks.reactivateTenant.mockResolvedValue({ tenantId: '1', status: 'active' });
    await userEvent.click(screen.getByRole('button', { name: 'Reactivate tenant' }));
    expect(mocks.reactivateTenant).toHaveBeenCalledWith('1', '');
  });
});
