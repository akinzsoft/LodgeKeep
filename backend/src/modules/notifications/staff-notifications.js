'use strict';

/**
 * Staff in-app notifications — gap closure (user-reported: "the notification
 * bell is not working. It is supposed to give notifications for activities
 * for booking, POS, guest QR ordered, rooms that are dirty, inventory out of
 * stock, reorder level, rooms checking out that day with outstanding
 * balance").
 *
 * Before this, exactly one code path ever wrote an `in_app_notifications`
 * row (a housekeeping discrepancy), broadcast to everyone at the property.
 * This file is the single writer every module now calls:
 *
 *   await notifyStaff({ trx, eventType: 'guest.checked_out', payload: {...} });
 *
 * Recipients are resolved BY ROLE at the caller's active property (confirmed
 * with the user): the event catalogue's default roles, with any
 * `notification_role_rules` override rows for this property applied on top.
 * Only active users are notified.
 *
 * `trx` is whatever property-bound scoped accessor the caller already holds
 * — a real transaction for a business mutation (the row commits atomically
 * with the change that caused it, never orphaned), or a plain worker-context
 * accessor for the departing-balance sweep. No tenant/property id is threaded
 * through: the accessor already injects both, the same way
 * `writeOutboxEvent({trx, ...})` works. Deliberately NOT through the outbox —
 * an internal row has none of the external-call problems that pattern exists
 * for (see the `in_app_notifications` migration's own header).
 *
 * The acting user is NOT excluded from their own notification — kept simple;
 * trivially addable later if it proves noisy.
 */

const { SYSTEM_ROLES } = require('../tenancy');
const { ValidationError } = require('../../shared/errors');

/**
 * The single catalogue of staff notification types. The Setup grid reads
 * this through `GET /notifications/catalogue`, so the frontend never keeps a
 * second copy of the list or its defaults.
 */
const NOTIFICATION_EVENTS = Object.freeze([
  {
    eventType: 'qr_ordering.guest_order_placed',
    group: 'POS & QR orders',
    label: 'New guest QR order',
    description: 'A guest QR order is paid (card or room charge) and ready to prepare. Also shows an on-screen card.',
    defaultRoles: ['pos_operator', 'manager', 'super_admin'],
  },
  {
    eventType: 'qr_ordering.guest_order_rejected',
    group: 'POS & QR orders',
    label: 'Guest QR order rejected',
    description: 'Staff rejected a guest QR order.',
    defaultRoles: ['pos_operator', 'manager'],
  },
  {
    eventType: 'pos.order_settled',
    group: 'POS & QR orders',
    label: 'POS order settled',
    description: 'A POS tab was paid.',
    defaultRoles: ['pos_operator', 'manager'],
  },
  {
    eventType: 'pos.settlement_voided',
    group: 'POS & QR orders',
    label: 'POS settlement voided',
    description: 'A POS settlement was voided after payment.',
    defaultRoles: ['pos_operator', 'manager'],
  },
  {
    eventType: 'stock.reorder_level_reached',
    group: 'Inventory',
    label: 'Stock at reorder level',
    description: 'A stock item dropped to or below its reorder level.',
    defaultRoles: ['pos_operator', 'manager'],
  },
  {
    eventType: 'stock.out_of_stock',
    group: 'Inventory',
    label: 'Stock out of stock',
    description: 'A stock item ran out. Menu items that use it become unavailable.',
    defaultRoles: ['pos_operator', 'manager', 'admin'],
  },
  {
    eventType: 'reservation.created',
    group: 'Bookings & front desk',
    label: 'New booking',
    description: 'A reservation was created (waitlist entries excluded).',
    defaultRoles: ['front_desk', 'manager'],
  },
  {
    eventType: 'reservation.cancelled',
    group: 'Bookings & front desk',
    label: 'Booking cancelled',
    description: 'A reservation was cancelled.',
    defaultRoles: ['front_desk', 'manager'],
  },
  {
    eventType: 'guest.checked_in',
    group: 'Bookings & front desk',
    label: 'Guest checked in',
    description: 'A guest checked in.',
    defaultRoles: ['front_desk', 'manager'],
  },
  {
    eventType: 'guest.checked_out',
    group: 'Bookings & front desk',
    label: 'Guest checked out',
    description: 'A guest checked out.',
    defaultRoles: ['front_desk', 'manager'],
  },
  {
    eventType: 'front_desk.departing_balance_outstanding',
    group: 'Bookings & front desk',
    label: 'Departing today with a balance',
    description: 'An in-house guest due to check out today still owes a balance. Sent once per guest per business date.',
    defaultRoles: ['front_desk', 'cashier', 'manager'],
  },
  {
    eventType: 'room.became_dirty',
    group: 'Housekeeping',
    label: 'Room needs cleaning',
    description: 'A room was vacated by a check-out or room move and is now dirty.',
    defaultRoles: ['housekeeping', 'manager'],
  },
  {
    eventType: 'housekeeping.discrepancy_raised',
    group: 'Housekeeping',
    label: 'Room status discrepancy',
    description: "A housekeeper's occupancy report disagrees with the front desk.",
    // Every role — exactly who this event notified before it moved onto the
    // role grid, so nothing changes for an unconfigured property.
    defaultRoles: [...SYSTEM_ROLES],
  },
]);

const NOTIFICATION_EVENTS_BY_TYPE = new Map(NOTIFICATION_EVENTS.map((event) => [event.eventType, event]));

/** Pure: the effective role set for one event type given this property's override rows for it. */
function effectiveRoles(eventType, overrideRows) {
  const roles = new Set(NOTIFICATION_EVENTS_BY_TYPE.get(eventType)?.defaultRoles ?? []);
  for (const row of overrideRows) {
    if (row.event_type !== eventType) continue;
    if (row.enabled) roles.add(row.role);
    else roles.delete(row.role);
  }
  return roles;
}

async function resolveRecipientUserIds({ trx, eventType }) {
  const overrides = await trx.table('notification_role_rules').where({ event_type: eventType });
  // MySQL returns BOOLEAN as 0/1 — coerce, never compare against `false`.
  const roles = effectiveRoles(
    eventType,
    overrides.map((row) => ({ ...row, enabled: Boolean(row.enabled) }))
  );
  if (roles.size === 0) return [];

  const rows = await trx
    .table('user_property_access')
    .whereIn('user_property_access.role', [...roles])
    .joinScoped('users', (join) => join.on('user_property_access.user_id', '=', 'users.id'))
    .where({ 'users.status': 'active' })
    .select('users.id as user_id');
  return [...new Set(rows.map((row) => String(row.user_id)))];
}

/**
 * Writes one bell row per recipient. With a `dedupKey`, a recipient who
 * already holds a row with that key is skipped (UNIQUE(tenant_id, user_id,
 * dedup_key)) — one insert per recipient, never a bulk insert, so a single
 * duplicate cannot abort the rows for everyone else.
 *
 * @returns {Promise<number>} rows actually written.
 */
async function notifyStaff({ trx, eventType, payload, dedupKey = null, popup = false }) {
  if (!NOTIFICATION_EVENTS_BY_TYPE.has(eventType)) {
    throw new Error(`notifyStaff: unknown staff notification type "${eventType}".`);
  }
  const userIds = await resolveRecipientUserIds({ trx, eventType });
  let written = 0;
  for (const userId of userIds) {
    try {
      await trx.table('in_app_notifications').insert({
        user_id: userId,
        type: eventType,
        payload: JSON.stringify(payload ?? {}),
        dedup_key: dedupKey,
        popup: Boolean(popup),
      });
      written += 1;
    } catch (error) {
      if (dedupKey && error?.code === 'ER_DUP_ENTRY') continue;
      throw error;
    }
  }
  return written;
}

async function listRoleRules({ db }) {
  const rows = await db.table('notification_role_rules').select('event_type', 'role', 'enabled').orderBy('id');
  return rows.map((row) => ({ eventType: row.event_type, role: row.role, enabled: Boolean(row.enabled) }));
}

/**
 * Upserts override rows. Validates every entry before writing any, so a bad
 * entry never leaves the grid half-saved.
 */
async function saveRoleRules({ db, rules }) {
  if (!Array.isArray(rules)) {
    throw new ValidationError('MISSING_FIELD', '"rules" must be an array.', [{ field: 'rules', issue: 'invalid' }]);
  }
  for (const [index, rule] of rules.entries()) {
    if (!NOTIFICATION_EVENTS_BY_TYPE.has(rule?.eventType)) {
      throw new ValidationError('INVALID_EVENT_TYPE', `"${rule?.eventType}" is not a known notification type.`, [
        { field: `rules[${index}].eventType`, issue: 'invalid' },
      ]);
    }
    if (!SYSTEM_ROLES.includes(rule?.role)) {
      throw new ValidationError('INVALID_ROLE', `"${rule?.role}" is not a known role.`, [
        { field: `rules[${index}].role`, issue: 'invalid' },
      ]);
    }
    if (typeof rule?.enabled !== 'boolean') {
      throw new ValidationError('INVALID_ENABLED', '"enabled" must be true or false.', [
        { field: `rules[${index}].enabled`, issue: 'invalid' },
      ]);
    }
  }

  await db.transaction(async (trx) => {
    for (const rule of rules) {
      const existing = await trx
        .table('notification_role_rules')
        .where({ event_type: rule.eventType, role: rule.role })
        .forUpdate()
        .first();
      if (existing) {
        await trx.table('notification_role_rules').where({ id: existing.id }).update({ enabled: rule.enabled });
      } else {
        await trx
          .table('notification_role_rules')
          .insert({ event_type: rule.eventType, role: rule.role, enabled: rule.enabled });
      }
    }
  });
  return listRoleRules({ db });
}

module.exports = {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENTS_BY_TYPE,
  effectiveRoles,
  notifyStaff,
  listRoleRules,
  saveRoleRules,
};
