'use strict';

/**
 * Profiles (Guest CRM) — PLAN.md Phase 2 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.1 ("Guest history, stay records, preferences"). `guests` itself and
 * `createGuest`/`getGuest`/`listGuests` already existed as a deliberate
 * Phase 2 stub (see that module's own header) — this module is the "real
 * Profiles module" that stub's own gap note names, adding search and stay
 * history without moving or duplicating what already works.
 *
 * `getGuest` is reused directly from `src/modules/reservations/service.js`
 * rather than re-querying `guests` here — the same cross-module
 * service-to-service call `reservations/service.js` itself already makes
 * into `cashiering/service.js` for folio adjustments.
 *
 * NOT built here, deliberately (PRODUCT_REQUIREMENTS.md §3.1's own further
 * scope, correctly out of this phase per PLAN.md): VIP flags, loyalty
 * program management (both Phase 6), and company/travel-agent profiles
 * (Phase 4, alongside Accounts Receivable). This pass is exactly PLAN.md's
 * named Phase 2 gap — "create, search, stay history" — nothing more.
 */

const { scopedDb } = require('../../db');
const { getGuest, getActiveGuestIds } = require('../reservations/service');

/**
 * Substring match across name/email/phone — `guests` is TENANT_SCOPED
 * (DATABASE.md §1: "one record across every property the tenant runs"), so
 * this searches the whole tenant, not just the active property.
 *
 * The OR across columns goes through the scoped accessor's own documented
 * disjunction escape hatch (`src/modules/tenancy/scoped-db.js`'s file
 * header: "a callback wrapped in its own parenthesised group") rather than
 * a top-level `orWhere`, which the accessor deliberately does not expose at
 * all for exactly the scope-leak reason that header explains.
 */
async function searchGuests({ context, query }) {
  const db = scopedDb().for(context);
  const pattern = `%${query}%`;
  return db
    .table('guests')
    .where({ status: 'active' })
    .where((group) =>
      group
        .where('first_name', 'like', pattern)
        .orWhere('last_name', 'like', pattern)
        .orWhere('email', 'like', pattern)
        .orWhere('phone', 'like', pattern)
    )
    .orderBy('last_name')
    .limit(50);
}

/**
 * Every reservation this guest has ever held, across every property in the
 * tenant — `acrossProperties()` because stay history is a tenant-wide
 * question about a tenant-wide guest, the same reasoning `listProperties`
 * (src/modules/setup/service.js) already gives for "which properties may I
 * work at."
 */
async function getGuestStayHistory({ context, id }) {
  const db = scopedDb().for(context);
  return (context.isImpersonation ? db : db.acrossProperties())
    .table('reservations')
    .where({ guest_id: id })
    .select(
      'id',
      'property_id',
      'room_type_id',
      'arrival_date',
      'departure_date',
      'status',
      'confirmation_number',
      'checked_in_at',
      'checked_out_at'
    )
    .orderBy('arrival_date', 'desc');
}

/**
 * Gap closure (user-reported): "add summary report on the profile num of
 * active and inactive customer" — the counts behind the report; see
 * `reservations/service.js`'s own `getActiveGuestIds` header for the real
 * definition of "active" this was confirmed against with the user
 * (a reservation arriving in the last 12 months, not the `guests.status`
 * GDPR field). Reused directly, not recomputed — the same cross-module
 * service-to-service call this file's own `getGuest` re-export already
 * establishes.
 */
async function getGuestActivitySummary({ context }) {
  const db = scopedDb().for(context);
  const guests = await db.table('guests').where({ status: 'active' }).select('id');
  const activeIds = await getActiveGuestIds({ context });
  const active = guests.filter((guest) => activeIds.has(String(guest.id))).length;
  return { active, inactive: guests.length - active };
}

// ---------------------------------------------------------------------
// Company profiles — PLAN.md Phase 4 (Accounts Receivable). DATABASE.md
// files `company_profiles` under this module (Guests & CRM) even though
// the module that actually bills against it (`src/modules/ar`) lives
// elsewhere — the same cross-module split `getGuest` above already models,
// just in the other direction: AR calls into this module for a company's
// name/billing_email rather than duplicating that lookup.
// ---------------------------------------------------------------------

async function createCompanyProfile({ context, name, type, billingEmail, billingPhone, billingAddress, paymentTermsDays }) {
  const db = scopedDb().for(context);
  const [id] = await db.table('company_profiles').insert({
    name,
    type: type ?? 'company',
    billing_email: billingEmail ?? null,
    billing_phone: billingPhone ?? null,
    billing_address: billingAddress ?? null,
    payment_terms_days: paymentTermsDays ?? 30,
  });
  return getCompanyProfile({ context, id });
}

/** Allowlisted at the controller layer (`pickCompanyProfileChanges`) — this session's confirmed decision to use the allowlist pattern from day one, since this endpoint has a real UI caller immediately (CLAUDE.md's own repeatedly-flagged lesson on raw `req.body` passthrough). */
async function updateCompanyProfile({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('company_profiles').where({ id }).update(changes);
  return getCompanyProfile({ context, id });
}

async function archiveCompanyProfile({ context, id }) {
  return updateCompanyProfile({ context, id, changes: { status: 'archived' } });
}

async function getCompanyProfile({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('company_profiles').where({ id }).first();
}

async function listCompanyProfiles({ context }) {
  const db = scopedDb().for(context);
  return db.table('company_profiles').where({ status: 'active' }).orderBy('name');
}

/** Substring match on name — the same disjunction-free single-column search `searchGuests` above needs a full OR-group for; a company name search does not. */
async function searchCompanyProfiles({ context, query }) {
  const db = scopedDb().for(context);
  return db.table('company_profiles').where({ status: 'active' }).where('name', 'like', `%${query}%`).orderBy('name').limit(50);
}

module.exports = {
  getGuest,
  searchGuests,
  getGuestStayHistory,
  getGuestActivitySummary,
  createCompanyProfile,
  updateCompanyProfile,
  archiveCompanyProfile,
  getCompanyProfile,
  listCompanyProfiles,
  searchCompanyProfiles,
};
