'use strict';

const { contextFromSession } = require('./context');

/**
 * Resolves a property by its slug, within a tenant — the "look this up
 * before any further-scoped context exists" bootstrap `guestLogin`
 * (src/auth/service.js) originally inlined. Promoted here once a second
 * caller (`guestRegister`) and a third (PLAN.md Phase 4's guest portal
 * module, `src/modules/portal`) all needed the identical lookup — the same
 * "promote a one-off once a second caller needs it" pattern
 * `src/shared/money.js`/`runIdempotentMutation` already followed.
 *
 * @param {object} params
 * @param {object} params.db  A bare `scopedDb()` instance (not yet bound to a context).
 * @param {string|number} params.tenantId
 * @param {string} params.propertySlug
 * @returns {Promise<object|undefined>} The `properties` row, or `undefined` if no property in this tenant has that slug.
 */
async function resolvePropertyBySlug({ db, tenantId, propertySlug }) {
  const tenantOnlyContext = contextFromSession({ tenantId });
  return db.for(tenantOnlyContext).table('properties').where({ slug: propertySlug }).first();
}

module.exports = { resolvePropertyBySlug };
