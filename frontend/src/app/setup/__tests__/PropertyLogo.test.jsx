import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyTab } from '../PropertyTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  updateProperty: vi.fn(),
  createProperty: vi.fn(),
  uploadPropertyLogo: vi.fn(),
  removePropertyLogo: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, setupApi: mocks };
});

const PROPERTY = { id: '3', name: 'Harbour View Hotel', slug: 'harbour', timezone: 'Africa/Lagos', base_currency: 'NGN', address: '', current_business_date: '2027-03-01', mfa_required_for_admin_roles: true, logo_url: null };

describe('<PropertyTab> logo', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  async function editProperty(property = PROPERTY, onPropertiesChanged = vi.fn()) {
    render(<PropertyTab properties={[property]} onPropertiesChanged={onPropertiesChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    return (await screen.findByRole('heading', { name: 'Logo' })).closest('section');
  }

  it('is only offered while editing an existing property', () => {
    render(<PropertyTab properties={[PROPERTY]} onPropertiesChanged={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Logo' })).not.toBeInTheDocument();
  });

  it('uploads a chosen logo straight away and refreshes the properties', async () => {
    const onPropertiesChanged = vi.fn();
    mocks.uploadPropertyLogo.mockResolvedValue({ ...PROPERTY, logo_url: '/api/v1/media/property-logos/x.png' });
    const card = await editProperty(PROPERTY, onPropertiesChanged);
    expect(within(card).getByText('No logo yet — the property name is used instead.')).toBeInTheDocument();

    const file = new File([new Uint8Array([0x89, 0x50])], 'logo.png', { type: 'image/png' });
    await userEvent.upload(within(card).getByLabelText('Upload logo'), file);

    expect(mocks.uploadPropertyLogo).toHaveBeenCalledWith('3', file);
    expect(onPropertiesChanged).toHaveBeenCalled();
    expect(await screen.findByText('Logo updated')).toBeInTheDocument();
  });

  it('refuses a non-image or oversized file before uploading', async () => {
    const card = await editProperty();
    await userEvent.upload(within(card).getByLabelText('Upload logo'), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('The logo must be 2 MB or smaller.');
    expect(mocks.uploadPropertyLogo).not.toHaveBeenCalled();
  });

  it('shows the current logo and removes it', async () => {
    const onPropertiesChanged = vi.fn();
    mocks.removePropertyLogo.mockResolvedValue({ ...PROPERTY, logo_url: null });
    const card = await editProperty({ ...PROPERTY, logo_url: '/api/v1/media/property-logos/current.png' }, onPropertiesChanged);
    expect(within(card).getByAltText('Harbour View Hotel logo')).toHaveAttribute('src', '/api/v1/media/property-logos/current.png');

    await userEvent.click(within(card).getByRole('button', { name: 'Remove logo' }));
    expect(mocks.removePropertyLogo).toHaveBeenCalledWith('3');
    expect(onPropertiesChanged).toHaveBeenCalled();
  });

  it('shows the real error when the upload is refused', async () => {
    mocks.uploadPropertyLogo.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to do this.' }));
    const card = await editProperty();
    await userEvent.upload(within(card).getByLabelText('Upload logo'), new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('You do not have permission to do this.');
  });
});
