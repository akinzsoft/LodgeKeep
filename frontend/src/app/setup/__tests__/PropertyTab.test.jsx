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

describe('<PropertyTab> — MFA toggle (gap closure)', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.updateProperty.mockResolvedValue(PROPERTY);
  });

  it('does not show the MFA checkbox on the create form', () => {
    render(<PropertyTab properties={[]} onPropertiesChanged={vi.fn()} />);
    expect(screen.queryByText(/require a verification code/i)).not.toBeInTheDocument();
  });

  it('shows the MFA checkbox, checked, when editing a property with it enabled (the default)', async () => {
    render(<PropertyTab properties={[PROPERTY]} onPropertiesChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('checkbox', { name: /require a verification code/i })).toBeChecked();
  });

  it('unchecking and saving sends mfa_required_for_admin_roles: false', async () => {
    render(<PropertyTab properties={[PROPERTY]} onPropertiesChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /require a verification code/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateProperty).toHaveBeenCalledWith('1', expect.objectContaining({ mfa_required_for_admin_roles: false }));
  });

  it('reflects an already-disabled property as unchecked', async () => {
    render(<PropertyTab properties={[{ ...PROPERTY, mfa_required_for_admin_roles: false }]} onPropertiesChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('checkbox', { name: /require a verification code/i })).not.toBeChecked();
  });
});
