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
