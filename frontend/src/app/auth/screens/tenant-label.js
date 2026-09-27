/**
 * Derives a display label for the login screen from the browser's own
 * hostname — "alpha-hotels.localhost" → "Alpha Hotels". The real tenant
 * name and logo come from `GET /auth/branding`; this is only the stand-in
 * shown until that answers, or if it fails, so the sign-in screen never
 * waits on it.
 */
export function deriveTenantLabelFromHost(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  const [firstLabel] = hostname.split('.');
  if (!firstLabel || firstLabel === 'localhost') return null;
  return firstLabel
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
