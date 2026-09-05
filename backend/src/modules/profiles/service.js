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
const { getGuest } = require('../reservations/service');

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
  return db
    .acrossProperties()
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

module.exports = { getGuest, searchGuests, getGuestStayHistory };
