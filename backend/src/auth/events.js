'use strict';

/**
 * Auth event logging — TESTING.md AUTH-14 ("any auth event: row in
 * auth_events"), PRODUCT_REQUIREMENTS.md §3.16 ("all authentication events are
 * audited").
 *
 * Every call goes through `systemContext()`: most auth events happen before —
 * or instead of — a real authenticated context existing (a failed login for an
 * unknown email has no user to attribute it to), and `auth_events` is
 * PLATFORM_SCOPED specifically so that is representable (see the migration and
 * `table-scopes.js`). This is the one file in the codebase that writes this
 * table.
 */

const { scopedDb } = require('../db');
const { systemContext } = require('../modules/tenancy');

/**
 * @param {object} event
 * @param {string} event.audience   'staff' | 'guest' | 'platform'
 * @param {string} event.eventType  one of the EVENT_TYPES enum in the migration
 * @param {string} [event.failureReason]
 * @param {string|null} [event.tenantId]
 * @param {string|null} [event.propertyId]
 * @param {string|null} [event.userId]
 * @param {string|null} [event.guestAccountId]
 * @param {string|null} [event.platformUserId]
 * @param {string} [event.emailAttempted]
 * @param {string} [event.ip]
 * @param {string} [event.userAgent]
 * @param {string} [event.requestId]
 */
async function writeAuthEvent(event) {
  const db = scopedDb().for(systemContext());
  return db.platform().table('auth_events').insert({
    audience: event.audience,
    event_type: event.eventType,
    failure_reason: event.failureReason ?? null,
    tenant_id: event.tenantId ?? null,
    property_id: event.propertyId ?? null,
    user_id: event.userId ?? null,
    guest_account_id: event.guestAccountId ?? null,
    platform_user_id: event.platformUserId ?? null,
    email_attempted: event.emailAttempted ?? null,
    ip: event.ip ?? null,
    user_agent: event.userAgent ?? null,
    request_id: event.requestId ?? null,
  });
}

module.exports = { writeAuthEvent };
