import { request } from './client.js';

/**
 * Profiles (Guest CRM) endpoint wrappers — PLAN.md Phase 2 gap closure,
 * PRODUCT_REQUIREMENTS.md §3.1's "create, search, stay history." Same shape
 * as `setup.js`. `createGuest`/`listGuests` already exist on
 * `reservationsApi` (the module that still routes them) — not duplicated
 * here.
 */

/** Gap closure (user-reported): "num of active and inactive customer." @returns {Promise<{active: number, inactive: number}>} */
export function getGuestActivitySummary() {
  return request('/guests/activity-summary');
}

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

// ---------------------------------------------------------------------
// Company profiles — PLAN.md Phase 4 (Accounts Receivable). CRUD lives in
// the Profiles module (`backend/src/modules/profiles`), matching
// PRODUCT_REQUIREMENTS.md's own screen placement and DATABASE.md's table
// filing under Guests & CRM — the AR module (`shared/api/ar.js`) references
// a company by id rather than duplicating this lookup. No `Idempotency-Key`
// on any of these — none is `runIdempotentMutation`-wrapped on the backend
// (`profiles/controller.js`'s company-profile handlers use plain
// `req.audit` instead), since this is reference data, not a financial
// posting.
// ---------------------------------------------------------------------

/** @param {string} [query] Substring match on name — omit for the full active list. */
export function listCompanyProfiles(query) {
  const search = query && query.trim() ? `?${new URLSearchParams({ q: query.trim() })}` : '';
  return request(`/companies${search}`);
}

export function getCompanyProfile(id) {
  return request(`/companies/${id}`);
}

/** @param {{name: string, type?: 'company'|'travel_agent'|'source', billingEmail?: string, billingPhone?: string, billingAddress?: string, paymentTermsDays?: number}} params */
export function createCompanyProfile({ name, type, billingEmail, billingPhone, billingAddress, paymentTermsDays }) {
  return request('/companies', {
    method: 'POST',
    body: {
      name,
      type,
      billing_email: billingEmail,
      billing_phone: billingPhone,
      billing_address: billingAddress,
      payment_terms_days: paymentTermsDays,
    },
  });
}

/** @param {string} id @param {{name?: string, type?: string, billingEmail?: string, billingPhone?: string, billingAddress?: string, paymentTermsDays?: number}} changes */
export function updateCompanyProfile(id, { name, type, billingEmail, billingPhone, billingAddress, paymentTermsDays } = {}) {
  return request(`/companies/${id}`, {
    method: 'PATCH',
    body: {
      name,
      type,
      billing_email: billingEmail,
      billing_phone: billingPhone,
      billing_address: billingAddress,
      payment_terms_days: paymentTermsDays,
    },
  });
}

export function archiveCompanyProfile(id) {
  return request(`/companies/${id}/archive`, { method: 'POST', body: {} });
}
