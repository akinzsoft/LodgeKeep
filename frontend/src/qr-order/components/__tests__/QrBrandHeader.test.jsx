import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrandingProvider } from '../../../shared/branding/BrandingProvider.jsx';
import { QrBrandHeader } from '../QrBrandHeader.jsx';

function renderWith(branding) {
  const fetchBranding = () => Promise.resolve(branding);
  return render(
    <BrandingProvider fetchBranding={fetchBranding} rootId="test-root">
      <QrBrandHeader />
    </BrandingProvider>
  );
}

describe('<QrBrandHeader>', () => {
  it('shows the uploaded logo beside the tenant name, with the property name beneath', async () => {
    renderWith({ name: 'Alpha Hotels — Main Property', tenantName: 'Alpha Hotels', logoUrl: '/api/v1/media/property-logos/x.png', theme: null });

    const logo = await screen.findByRole('img', { name: 'Alpha Hotels logo' });
    expect(logo).toHaveAttribute('src', '/api/v1/media/property-logos/x.png');
    expect(screen.getByText('Alpha Hotels')).toBeInTheDocument();
    expect(screen.getByText('Alpha Hotels — Main Property')).toBeInTheDocument();
  });

  it('falls back to a monogram when there is no logo, or the logo fails to load', async () => {
    const { unmount } = renderWith({ name: 'Harbour View', tenantName: 'Harbour Group', logoUrl: null, theme: null });
    expect(await screen.findByText('Harbour Group')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('H')).toBeInTheDocument();
    unmount();

    renderWith({ name: 'Harbour View', tenantName: 'Harbour Group', logoUrl: '/broken.png', theme: null });
    fireEvent.error(await screen.findByRole('img', { name: 'Harbour Group logo' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('H')).toBeInTheDocument();
  });

  it('uses the property name alone when no tenant name is known, without repeating it', async () => {
    renderWith({ name: 'Harbour View', tenantName: null, logoUrl: null, theme: null });
    expect(await screen.findAllByText('Harbour View')).toHaveLength(1);
  });

  it('renders nothing once branding failed to load', async () => {
    const fetchBranding = () => Promise.reject(new Error('down'));
    const { container } = render(
      <BrandingProvider fetchBranding={fetchBranding} rootId="test-root">
        <QrBrandHeader />
      </BrandingProvider>
    );
    // A loading placeholder first, then nothing at all — never an empty band.
    expect(container.querySelector('header')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(container.querySelector('header')).toBeNull());
  });
});
