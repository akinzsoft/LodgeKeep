/**
 * Derives a display label for the login screen's branding panel from the
 * browser's own hostname — "alpha-hotels.localhost" → "Alpha Hotels". This
 * is a UI-only guess, not fetched data: no endpoint returns tenant branding
 * before login (`GET /api/v1/me`-shaped or a public tenant-info route,
 * neither built — the same category of gap `AuthContext.jsx`'s header
 * documents for post-login display names). PRODUCT_REQUIREMENTS.md §3.16
 * asks for "tenant-branded" login, which today means "resolved to the right
 * tenant by Host header" (real, via `src/auth/tenant-resolution.js`) rather
 * than "carries the tenant's actual logo/colours" (not real yet — that needs
 * the tenant theming config DESIGN_SYSTEM.md §1 describes, which has no
 * read endpoint either). Showing the subdomain, formatted, is the honest
 * middle ground: real information the browser already has, not invented.
 */
export function deriveTenantLabelFromHost(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  const [firstLabel] = hostname.split('.');
  if (!firstLabel || firstLabel === 'localhost') return null;
  return firstLabel
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
