import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformApp } from '../PlatformApp.jsx';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  enrollConfirm: vi.fn(),
  verifyMfa: vi.fn(),
  listTenants: vi.fn(),
  getTenant: vi.fn(),
  listImpersonationSessionsForTenant: vi.fn(),
  startImpersonation: vi.fn(),
  endImpersonation: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks }, configureApiClient: mocks.configureApiClient };
});

const TENANT = { id: '1', name: 'Acme Hotels', slug: 'acme', status: 'active' };
const TENANT_DETAIL = { ...TENANT, properties: [{ id: '20', name: 'Acme Main', slug: 'acme-main', status: 'active' }] };

describe('<PlatformApp> — the full state-machine wiring', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listTenants.mockResolvedValue([TENANT]);
    mocks.getTenant.mockResolvedValue(TENANT_DETAIL);
    mocks.listImpersonationSessionsForTenant.mockResolvedValue([]);
  });

  it('keeps the login screen visible while authentication is pending', async () => {
    mocks.login.mockReturnValue(new Promise(() => {}));
    render(<PlatformApp />);
    await userEvent.type(screen.getByLabelText('Email'), 'ops@lodgekeep.test');
    await userEvent.type(screen.getByLabelText('Password'), 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(mocks.listTenants).not.toHaveBeenCalled();
  });

  it('walks login -> MFA challenge -> console -> tenant detail -> impersonate -> exit', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'challenge-token' });
    mocks.verifyMfa.mockResolvedValue({ status: 'ok', accessToken: 'platform-token' });
    mocks.startImpersonation.mockResolvedValue({
      accessToken: 'impersonation-token',
      tenantId: '1',
      tenantName: 'Acme Hotels',
      propertyId: '20',
      impersonationSessionId: '9',
    });
    mocks.endImpersonation.mockResolvedValue({ ended: true });

    render(<PlatformApp />);

    await userEvent.type(screen.getByLabelText('Email'), 'ops@lodgekeep.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a real password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await userEvent.type(await screen.findByLabelText('6-digit code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    // Console — the real tenant list.
    expect(await screen.findByText('Acme Hotels')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View' }));

    // Tenant detail — start impersonation.
    await screen.findByRole('heading', { name: 'Acme Hotels' });
    await userEvent.type(screen.getByLabelText(/Reason/), 'Support ticket #1');
    await userEvent.click(screen.getByRole('button', { name: 'Start impersonation' }));

    // Impersonated view — the real AppShell + banner, no dev-facing console chrome.
    expect(await screen.findByText(/Viewing/)).toHaveTextContent('Acme Hotels');
    expect(mocks.startImpersonation).toHaveBeenCalledWith('1', { propertyId: '20', reason: 'Support ticket #1' });

    // Exit returns to the console.
    await userEvent.click(screen.getByRole('button', { name: 'Exit impersonation' }));
    expect(await screen.findByText('Acme Hotels')).toBeInTheDocument();
    expect(mocks.endImpersonation).toHaveBeenCalled();
  });

  it('a first-ever login goes through real enrollment before reaching the console', async () => {
    mocks.login.mockResolvedValue({
      status: 'mfa_enrollment_required',
      enrollmentToken: 'enroll-token',
      otpAuthUrl: 'otpauth://totp/x',
      qrCodeDataUrl: 'data:image/png;base64,abc',
      manualEntryKey: 'ABCDEF',
    });
    mocks.enrollConfirm.mockResolvedValue({ status: 'ok', accessToken: 'platform-token' });

    render(<PlatformApp />);
    await userEvent.type(screen.getByLabelText('Email'), 'ops@lodgekeep.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a real password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByAltText('Scan with your authenticator app')).toBeInTheDocument();
  });
});
