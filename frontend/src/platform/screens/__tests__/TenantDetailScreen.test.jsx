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
  configureApiClient: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks }, configureApiClient: mocks.configureApiClient };
});

const TENANT = {
  id: '1',
  name: 'Acme Hotels',
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

    await userEvent.type(screen.getByLabelText(/Reason/), 'Debugging billing issue');
    await userEvent.click(screen.getByRole('button', { name: 'Start impersonation' }));

    expect(mocks.startImpersonation).toHaveBeenCalledWith('1', { propertyId: '20', reason: 'Debugging billing issue' });
  });

  it('surfaces a real backend error from starting impersonation', async () => {
    mocks.startImpersonation.mockRejectedValue(new ApiError({ code: 'VALIDATION_PROPERTY_NOT_IN_TENANT', message: 'The specified property does not belong to this tenant.' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Acme Hotels' });

    await userEvent.type(screen.getByLabelText(/Reason/), 'Debugging billing issue');
    await userEvent.click(screen.getByRole('button', { name: 'Start impersonation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The specified property does not belong to this tenant.');
  });
});
