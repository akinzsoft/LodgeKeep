import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrandingTab } from '../BrandingTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  uploadPropertyLogo: vi.fn(),
  removePropertyLogo: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, setupApi: mocks };
});

const PROPERTY = { id: '3', name: 'Harbour View Hotel', address: '12 Marina Road, Lagos', logo_url: null };
const png = () => new File([new Uint8Array([0x89, 0x50])], 'logo.png', { type: 'image/png' });

describe('<BrandingTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('asks for an active property when there is none', () => {
    render(<BrandingTab activeProperty={null} onPropertiesChanged={vi.fn()} />);
    expect(screen.getByText('Select an active property to set its branding.')).toBeInTheDocument();
  });

  it('shows the property name in place of a logo on the receipt and email previews until one is uploaded', () => {
    render(<BrandingTab activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    expect(screen.getByText('No logo yet — your property name is used in its place.')).toBeInTheDocument();
    const receipt = screen.getByLabelText('Receipt preview');
    expect(within(receipt).getByText('Harbour View Hotel')).toBeInTheDocument();
    expect(within(receipt).getByText('12 Marina Road, Lagos')).toBeInTheDocument();
    expect(within(receipt).queryByRole('img', { hidden: true })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Email preview')).getAllByText('Harbour View Hotel').length).toBeGreaterThan(0);
  });

  it('uploads a chosen logo straight away and refreshes the property records', async () => {
    const onPropertiesChanged = vi.fn();
    mocks.uploadPropertyLogo.mockResolvedValue({ ...PROPERTY, logo_url: '/api/v1/media/property-logos/x.png' });
    render(<BrandingTab activeProperty={PROPERTY} onPropertiesChanged={onPropertiesChanged} />);

    const file = png();
    await userEvent.upload(screen.getByLabelText('Upload logo'), file);

    expect(mocks.uploadPropertyLogo).toHaveBeenCalledWith('3', file);
    expect(onPropertiesChanged).toHaveBeenCalled();
    expect(await screen.findByText('Logo updated')).toBeInTheDocument();
  });

  it('previews the logo on the receipt (grayscale) and in the email header', () => {
    const logo = '/api/v1/media/property-logos/current.png';
    const { container } = render(<BrandingTab activeProperty={{ ...PROPERTY, logo_url: logo }} onPropertiesChanged={vi.fn()} />);
    expect(screen.getByAltText('Harbour View Hotel logo')).toHaveAttribute('src', logo);
    expect(screen.getByLabelText('Receipt preview').querySelector('img')).toHaveAttribute('src', logo);
    expect(screen.getByLabelText('Email preview').querySelector('img')).toHaveAttribute('src', logo);
    expect(container.querySelectorAll(`img[src="${logo}"]`)).toHaveLength(3);
  });

  it('warns when the uploaded logo is too small to stay crisp', () => {
    render(<BrandingTab activeProperty={{ ...PROPERTY, logo_url: '/api/v1/media/property-logos/small.png' }} onPropertiesChanged={vi.fn()} />);
    const img = screen.getByAltText('Harbour View Hotel logo');
    Object.defineProperty(img, 'naturalWidth', { value: 200 });
    Object.defineProperty(img, 'naturalHeight', { value: 60 });
    fireEvent.load(img);
    expect(screen.getByText(/200 × 60 px — this is small and may look soft/)).toBeInTheDocument();
  });

  it('refuses a non-image or oversized file before uploading', async () => {
    render(<BrandingTab activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText('Upload logo'), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The logo must be 2 MB or smaller.');
    expect(mocks.uploadPropertyLogo).not.toHaveBeenCalled();
  });

  it('removes the logo', async () => {
    const onPropertiesChanged = vi.fn();
    mocks.removePropertyLogo.mockResolvedValue({ ...PROPERTY, logo_url: null });
    render(<BrandingTab activeProperty={{ ...PROPERTY, logo_url: '/api/v1/media/property-logos/current.png' }} onPropertiesChanged={onPropertiesChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove logo' }));
    expect(mocks.removePropertyLogo).toHaveBeenCalledWith('3');
    expect(onPropertiesChanged).toHaveBeenCalled();
  });

  it('shows the real error when the upload is refused', async () => {
    mocks.uploadPropertyLogo.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'You do not have permission to do this.' }));
    render(<BrandingTab activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText('Upload logo'), png());
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do this.');
  });

  it('disables changes while offline', () => {
    render(<BrandingTab activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} isOffline />);
    expect(screen.getByLabelText('Upload logo')).toBeDisabled();
  });
});
