import { createContext, useContext, useEffect, useState } from 'react';
import { ApiError } from '../api/index.js';

/**
 * BrandingProvider — the ONE tenant-theming mechanism for every guest-facing
 * surface in this codebase (PRODUCT_REQUIREMENTS.md §3.14: "tenant-themed";
 * PLAN.md's own Phase 4 exit gate: "portal renders with tenant colours and
 * logo, with no admin styling leaking in"). Originally built for, and
 * living inside, `portal/` — promoted here once QR self-ordering (Phase 6)
 * needed the identical mechanism for the identical class of surface
 * (guest-facing, tenant-branded, no login), the same "promote a one-off
 * once a second caller needs it" move this codebase's own history repeats
 * (`shared/money.js`, `shared/mutation.js`, `tenancy/property-resolution.js`).
 * There is deliberately no second theming system — a caller that needs its
 * own fetch shape passes its own `fetchBranding`, not its own component.
 *
 * `fetchBranding` is an async function taking no arguments (the caller
 * closes over whatever it needs — a property slug for the portal, a raw
 * QR token for self-ordering) and resolving to `{name, logoUrl, theme,
 * baseCurrency}` — the exact shape `portalService.getPropertyBranding`
 * returns, reused verbatim by both backend routes that expose it
 * (`GET /portal/properties/branding`, `GET /qr-order/:token/branding`).
 * The effect below re-fetches whenever `fetchBranding` itself changes
 * identity — callers wrap it in `useCallback`, keyed on whatever value
 * (a property slug, a token) should trigger a re-fetch, the same
 * reactivity the pre-promotion `[propertySlug]` dependency array gave the
 * portal's own original version of this file.
 *
 * `theme` is a nullable JSON blob with no schema enforced anywhere in this
 * codebase (`properties.theme`'s own migration leaves its shape to the
 * first real caller) — this file reads only two keys (`primaryColor`,
 * `primaryTint`), the two tokens `Button`'s own primary variant and the
 * domain-tint backgrounds actually use, applied as inline CSS
 * custom-property overrides on `rootId`'s own wrapper div — exactly the
 * mechanism `styles/tokens.css`'s own header already documents
 * ("redefining these same custom properties at a narrower scope"), never
 * `:root`/`document.body`. A property with no `theme` configured yet gets
 * the product's own default look — nothing overridden, nothing invented.
 *
 * Scoping the override to `rootId`'s own wrapper (not `:root`) is what
 * makes "no admin styling leak" hold structurally: the staff app, the
 * portal, and the QR-ordering app are never mounted together in one page
 * load (`main.jsx`'s pathname fork), so each caller's own `rootId` is
 * purely a DOM-identity convenience, not a second isolation mechanism.
 */

const BrandingContext = createContext(null);

export function BrandingProvider({ fetchBranding, rootId, children }) {
  const [branding, setBranding] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchBranding()
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
  }, [fetchBranding]);

  const themeStyle = {};
  if (branding?.theme?.primaryColor) themeStyle['--domain-booking'] = branding.theme.primaryColor;
  if (branding?.theme?.primaryTint) themeStyle['--domain-booking-tint'] = branding.theme.primaryTint;

  return (
    <BrandingContext.Provider value={{ branding, error }}>
      <div id={rootId} style={themeStyle}>
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
