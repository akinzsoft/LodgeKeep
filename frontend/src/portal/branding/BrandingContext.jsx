import { createContext, useContext, useEffect, useState } from 'react';
import { portalApi, ApiError } from '../../shared/api/index.js';

/**
 * BrandingContext — PLAN.md Phase 4's tenant-theming requirement
 * (PRODUCT_REQUIREMENTS.md §3.14: "tenant-themed"; PLAN.md's own exit gate:
 * "portal renders with tenant colours and logo, with no admin styling
 * leaking in"). Fetches `GET /portal/properties/branding` once per
 * `propertySlug` and renders its own root wrapper with `theme`'s colors
 * applied as inline CSS custom-property overrides — exactly the mechanism
 * `styles/tokens.css`'s own header already documents ("redefining these
 * same custom properties at a narrower scope, e.g. on the portal's root
 * element"), never a second theming system.
 *
 * `theme` is a nullable JSON blob with no schema enforced anywhere in this
 * codebase (`properties.theme`'s own migration leaves its shape to the
 * first real caller) — this file is that first caller, and deliberately
 * reads only two keys (`primaryColor`, `primaryTint`), the two tokens
 * `Button`'s own primary variant and the domain-tint backgrounds actually
 * use. A tenant with no `theme` configured yet (every dev tenant today)
 * gets the product's own default look — nothing overridden, nothing
 * invented.
 *
 * The override is scoped to THIS component's own wrapper div, never
 * `:root`/`document.body` — since the staff app and the portal are never
 * mounted in the same page load (`main.jsx`'s pathname fork), "no admin
 * styling leak" holds structurally, not just by convention.
 */

const BrandingContext = createContext(null);

export function BrandingProvider({ propertySlug, children }) {
  const [branding, setBranding] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .getPropertyBranding(propertySlug)
      .then((result) => {
        if (!cancelled) setBranding(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        setBranding({ name: null, logoUrl: null, theme: null });
        setError(caught instanceof ApiError ? caught.message : 'Could not load property information.');
      });
    return () => {
      cancelled = true;
    };
  }, [propertySlug]);

  const themeStyle = {};
  if (branding?.theme?.primaryColor) themeStyle['--domain-booking'] = branding.theme.primaryColor;
  if (branding?.theme?.primaryTint) themeStyle['--domain-booking-tint'] = branding.theme.primaryTint;

  return (
    <BrandingContext.Provider value={{ branding, error }}>
      <div id="portal-root" style={themeStyle}>
        {children}
      </div>
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  const context = useContext(BrandingContext);
  if (!context) throw new Error('useBranding() must be called within a <BrandingProvider>.');
  return context;
}
