'use strict';

/**
 * Staff outlet assignments (`user_outlet_assignments`) — the one place that
 * answers "which outlets does this person cover here?" for stock requests
 * and their alerts. Confirmed with the user:
 *
 *   - manager, admin and super_admin are never limited;
 *   - anyone else with NO assignment at the property covers every outlet
 *     (today's behaviour — nothing changes until an admin assigns someone);
 *   - anyone else WITH assignments covers exactly those outlets.
 *
 * Every function takes a property-bound scoped accessor (`db`), so the role
 * and the assignments read are always the active property's.
 */

const UNRESTRICTED_ROLES = Object.freeze(['manager', 'admin', 'super_admin']);

/**
 * The outlets `userId` covers at the accessor's property: `null` when
 * unrestricted (every outlet), otherwise a non-empty array of outlet ids as
 * strings.
 */
async function outletScopeForUser(db, userId) {
  if (!userId) return null;
  const access = await db.table('user_property_access').where({ user_id: userId }).first('role');
  if (!access || UNRESTRICTED_ROLES.includes(access.role)) return null;
  const rows = await db.table('user_outlet_assignments').where({ user_id: userId }).select('outlet_id');
  return rows.length ? rows.map((row) => String(row.outlet_id)) : null;
}

/** True when a scope from `outletScopeForUser` reaches any of `outletIds`. */
function scopeCovers(scope, outletIds) {
  if (scope === null) return true;
  return outletIds.some((id) => scope.includes(String(id)));
}

/**
 * Of `userIds`, the ones who cover at least one of `outletIds` at the
 * accessor's property — for addressing an alert to the people at the
 * outlets it concerns. Two queries for the whole list, never one per user.
 */
async function usersCoveringOutlets(db, userIds, outletIds) {
  if (!userIds.length) return [];
  const [accessRows, assignmentRows] = [
    await db.table('user_property_access').whereIn('user_id', userIds).select('user_id', 'role'),
    await db.table('user_outlet_assignments').whereIn('user_id', userIds).select('user_id', 'outlet_id'),
  ];
  const roleOf = new Map(accessRows.map((row) => [String(row.user_id), row.role]));
  const assigned = new Map();
  for (const row of assignmentRows) {
    const list = assigned.get(String(row.user_id)) ?? [];
    list.push(String(row.outlet_id));
    assigned.set(String(row.user_id), list);
  }
  const wanted = outletIds.map(String);
  return userIds.filter((id) => {
    const key = String(id);
    if (UNRESTRICTED_ROLES.includes(roleOf.get(key))) return true;
    const mine = assigned.get(key);
    return !mine || mine.some((outletId) => wanted.includes(outletId));
  });
}

module.exports = { UNRESTRICTED_ROLES, outletScopeForUser, scopeCovers, usersCoveringOutlets };
