import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyTab } from '../PropertyTab.jsx';

const mocks = vi.hoisted(() => ({
  createProperty: vi.fn(),
  updateProperty: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { createProperty: mocks.createProperty, updateProperty: mocks.updateProperty },
  };
});

const PROPERTY = {
  id: '1',
  name: 'Alpha Hotels',
  slug: 'alpha-hotels',
  timezone: 'Africa/Lagos',
  base_currency: 'NGN',
  address: null,
  current_business_date: '2026-09-01',
  mfa_required_for_admin_roles: true,
};

describe('<PropertyTab> — the MFA switch lives on the Security tab', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.updateProperty.mockResolvedValue(PROPERTY);
  });

  it('has no verification-code checkbox on create or edit', async () => {
    const { unmount } = render(<PropertyTab properties={[]} onPropertiesChanged={vi.fn()} />);
    expect(screen.queryByText(/verification code/i)).not.toBeInTheDocument();
    unmount();
    render(<PropertyTab properties={[PROPERTY]} onPropertiesChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('saving a property never sends mfa_required_for_admin_roles', async () => {
    render(<PropertyTab properties={[PROPERTY]} onPropertiesChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateProperty).toHaveBeenCalledTimes(1);
    expect(mocks.updateProperty.mock.calls[0][1]).not.toHaveProperty('mfa_required_for_admin_roles');
  });
});
