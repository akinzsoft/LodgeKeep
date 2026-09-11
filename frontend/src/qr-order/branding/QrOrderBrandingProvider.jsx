/**
 * QrOrderBrandingProvider — a deliberately minimal counterpart to
 * `portal/branding/BrandingContext.jsx`. That file fetches `GET
 * /portal/properties/branding?property_slug=...` (a real endpoint, keyed by
 * property slug) and applies `theme.primaryColor`/`primaryTint` as inline
 * CSS custom-property overrides on its own wrapper div — never `:root`, so
 * "no admin styling leak" holds structurally.
 *
 * No equivalent branding endpoint exists on the QR-ordering surface (there
 * is no `GET .../branding` route in `backend/src/modules/qr-ordering/routes.js`
 * — only `/menu`, `/orders`, and the room-charge sub-routes, all keyed by the
 * scanned TOKEN, not a property slug). Rather than inventing a new backend
 * endpoint this frontend-only pass has no authorization to add, this
 * provider applies the SAME `--domain-booking`/`--domain-booking-tint`
 * override MECHANISM `BrandingContext.jsx` already established, scoped to
 * this app's own wrapper div, but with no theme DATA to read yet — every QR
 * order screen renders with this product's own default look until a real
 * per-tenant theme source exists for this surface. Kept as its own thin
 * component (rather than skipped entirely) so the moment a real endpoint
 * exists, only this one file needs to change.
 */
export function QrOrderBrandingProvider({ children }) {
  return (
    <div id="qr-order-root" style={{}}>
      {children}
    </div>
  );
}
