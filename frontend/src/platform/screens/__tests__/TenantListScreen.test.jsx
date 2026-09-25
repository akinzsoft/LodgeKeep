import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TenantListScreen } from '../TenantListScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ listTenants: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, listTenants: mocks.listTenants } };
});

const TENANT = { id: '1', name: 'Acme Hotels', slug: 'acme', status: 'active' };

const TENANT_WITH_HEALTH = {
  id: '2',
  name: 'Beta Resorts',
  slug: 'beta',
  status: 'trial',
  created_at: '2027-01-01 00:00:00',
  plan: { code: 'standard', name: 'Standard' },
  property_count: 3,
  trial_days_remaining: 7,
  subscription_status: 'past_due',
  last_login_at: '2027-01-10 09:00:00',
};

describe('<TenantListScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listTenants.mockResolvedValue([TENANT]);
  });

  it('lists real tenants', async () => {
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByText('Acme Hotels')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('shows real health signals — plan, property count, trial, subscription status, last login', async () => {
    mocks.listTenants.mockResolvedValue([TENANT_WITH_HEALTH]);
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByText('Beta Resorts');
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('7d left')).toBeInTheDocument();
    expect(screen.getByText('past_due')).toBeInTheDocument();
    expect(screen.getByText('2027-01-10 09:00:00')).toBeInTheDocument();
  });

  it('flags an offboarding tenant whose deletion is blocked, and shows purging/purged as their own statuses', async () => {
    mocks.listTenants.mockResolvedValue([
      { ...TENANT, id: '1', name: 'Stuck Inn', status: 'offboarding', purge_blocked: true },
      { ...TENANT, id: '2', name: 'Going Inn', status: 'purging', purge_blocked: false },
      { ...TENANT, id: '3', name: 'Gone Inn', status: 'purged', purge_blocked: false },
    ]);
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByText('Stuck Inn');
    expect(screen.getAllByText('Deletion blocked')).toHaveLength(1);
    expect(screen.getByText('purging')).toBeInTheDocument();
    expect(screen.getByText('purged')).toBeInTheDocument();
  });

  it('shows honest fallbacks — no plan, never logged in, no subscription, not a trial', async () => {
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByText('Acme Hotels');
    expect(screen.getByText('No plan')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.getByText('No subscription')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('clicking View calls onSelectTenant with the real id', async () => {
    const onSelectTenant = vi.fn();
    render(<TenantListScreen onSelectTenant={onSelectTenant} onLogout={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(onSelectTenant).toHaveBeenCalledWith('1');
  });

  it('surfaces a real backend error', async () => {
    mocks.listTenants.mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.' }));
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });

  it('Sign out calls onLogout', async () => {
    const onLogout = vi.fn();
    render(<TenantListScreen onSelectTenant={vi.fn()} onLogout={onLogout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
