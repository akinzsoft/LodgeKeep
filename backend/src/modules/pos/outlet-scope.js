'use strict';

/**
 * Staff outlet assignments reach the Register and Shifts (user-requested:
 * "restrict outlet assignments to Register and shifts too"). Until now an
 * assignment limited stock requests only (`gap-staff-outlets`); an
 * assigned operator could still open, sell, void and settle tabs, and open
 * or read shifts, at any outlet of the property.
 *
 * The rule is the one `src/shared/outlet-assignments.js` already defines:
 * manager/admin/super_admin, and anyone with no assignment, cover every
 * outlet; anyone else covers exactly their assigned outlets.
 *
 * - Starting something at an outlet (a tab, a shift, the stock-out toggle)
 *   outside those outlets is `400 VALIDATION_OUTLET_NOT_ASSIGNED`, the same
 *   answer a stock request gets.
 * - An existing tab, tab line or shift at another outlet is `404`, never
 *   403, so its existence is not confirmed (the stock-request rule).
 * - Lists (tabs, terminals, shifts) show only the caller's outlets.
 *
 * Checked in route middleware, before the handler: an order's `outlet_id`,
 * an order line's order, a shift's terminal and a terminal's outlet never
 * change once written (no update path touches them), so there is nothing a
 * concurrent request could move between this check and the handler's own
 * locks.
 *
 * Deliberately NOT covered (not asked): Tickets, Guest orders, the room-
 * charge guest lookup, menu reads, and closing a shift — the opener may
 * always close their own till even if reassigned since, and anyone else
 * needs `pos.manage`, which only unrestricted roles hold.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { notFound } = require('../../shared/response');
const { outletScopeForUser, scopeCovers } = require('../../shared/outlet-assignments');

/** The caller's outlet scope at the active property: `null` = every outlet. */
async function scopeForRequest(req) {
  // An impersonating platform admin holds no staff grant here (and cannot
  // mutate anything anyway); reads are never limited for them.
  if (req.context.isImpersonation) return null;
  return outletScopeForUser(scopedDb().for(req.context), req.context.userId);
}

function outletNotAssigned(field) {
  return new ValidationError('OUTLET_NOT_ASSIGNED', 'You are not assigned to this outlet.', [{ field, issue: 'not_assigned' }]);
}

/**
 * Middleware for a route acting on an existing record. `resolveOutletId`
 * returns the record's outlet id, or `undefined` when the record does not
 * exist (the handler then answers "not found" in its own words).
 */
function requireExistingInScope(resolveOutletId) {
  return async function existingInOutletScope(req, res, next) {
    try {
      const scope = await scopeForRequest(req);
      if (scope === null) return next();
      const outletId = await resolveOutletId(scopedDb().for(req.context), req);
      if (outletId === undefined) return next();
      if (!scopeCovers(scope, [outletId])) return notFound(res);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Middleware for a route starting something at an outlet named in the request. */
function requireNamedOutletInScope(field, resolveOutletId) {
  return async function namedOutletInScope(req, res, next) {
    try {
      const scope = await scopeForRequest(req);
      if (scope === null) return next();
      const outletId = await resolveOutletId(scopedDb().for(req.context), req);
      // Missing/unknown ids are the handler's own validation error.
      if (outletId === undefined || outletId === null) return next();
      if (!scopeCovers(scope, [outletId])) throw outletNotAssigned(field);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

async function outletOfOrder(db, orderId) {
  const order = await db.table('pos_orders').where({ id: orderId }).first('outlet_id');
  return order ? order.outlet_id : undefined;
}

async function outletOfTerminal(db, terminalId) {
  const terminal = await db.table('pos_terminals').where({ id: terminalId }).first('outlet_id');
  return terminal ? terminal.outlet_id : undefined;
}

const orderInScope = requireExistingInScope((db, req) => outletOfOrder(db, req.params.id));

/** A tab line's own order decides — the services act on the line id alone. */
const orderItemInScope = requireExistingInScope(async (db, req) => {
  const item = await db.table('pos_order_items').where({ id: req.params.itemId }).first('pos_order_id');
  return item ? outletOfOrder(db, item.pos_order_id) : undefined;
});

const shiftInScope = requireExistingInScope(async (db, req) => {
  const shift = await db.table('pos_shifts').where({ id: req.params.id }).first('terminal_id');
  return shift ? outletOfTerminal(db, shift.terminal_id) : undefined;
});

const newOrderOutletInScope = requireNamedOutletInScope('outlet_id', async (db, req) => req.body?.outlet_id);
const availabilityOutletInScope = requireNamedOutletInScope('outlet_id', async (db, req) => req.body?.outlet_id);
const newShiftTerminalInScope = requireNamedOutletInScope('terminal_id', async (db, req) =>
  req.body?.terminal_id ? outletOfTerminal(db, req.body.terminal_id) : undefined
);

/**
 * `GET /pos/my-outlets`: what the Register and Shifts screens may offer.
 * `{restricted: false, outletIds: null}` means every outlet.
 */
async function describeScope(req) {
  const scope = await scopeForRequest(req);
  return scope === null ? { restricted: false, outletIds: null } : { restricted: true, outletIds: scope };
}

module.exports = {
  scopeForRequest,
  describeScope,
  orderInScope,
  orderItemInScope,
  shiftInScope,
  newOrderOutletInScope,
  availabilityOutletInScope,
  newShiftTerminalInScope,
};
