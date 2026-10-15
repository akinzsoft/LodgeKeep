import { request } from './client.js';

/**
 * The marketing landing page's content (backend `landing-content`). Public: no
 * login and no tenant, so `auth: false`. Returns `{overrides, monthly, trialDays,
 * updatedAt}`; the page applies it over its built-in defaults.
 */
export function getPublicLandingContent() {
  return request('/public/landing-content', { auth: false });
}
