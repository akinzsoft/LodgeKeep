import { request } from './client.js';

/**
 * Profiles (Guest CRM) endpoint wrappers — PLAN.md Phase 2 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.1's "create, search, stay history." Same shape
 * as `setup.js`. `createGuest`/`listGuests` already exist on
 * `reservationsApi` (the module that still routes them) — not duplicated
 * here.
 */

export function searchGuests(query) {
  const params = new URLSearchParams({ q: query });
  return request(`/guests/search?${params}`);
}

export function getGuest(id) {
  return request(`/guests/${id}`);
}

export function getGuestStayHistory(id) {
  return request(`/guests/${id}/stay-history`);
}
