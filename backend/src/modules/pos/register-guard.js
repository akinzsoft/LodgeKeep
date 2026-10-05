'use strict';

/**
 * The Register's routes on an EXISTING tab refuse a tab at a supermarket outlet. A supermarket sells only
 * from the Supermarket screen (its sale takes the gapless receipt number and writes the receipt snapshot);
 * a tab added to or settled through the Register would not. New tabs are refused by `openOrder` itself;
 * this covers one that already exists (for example the empty tab left from before the outlet was
 * converted).
 *
 * Route-level on purpose: the supermarket's own sale calls the shared `settleOrder` internally and never
 * goes through these routes. Voids are NOT guarded, so a manager can still clear such a tab.
 */

const { scopedDb } = require('../../db');
const { isSupermarketOutlet } = require('../../shared/outlet-types');
const { SupermarketOutletNotARegisterError } = require('./errors');

async function refuseSupermarketTab(req, res, next) {
  try {
    const db = scopedDb().for(req.context);
    // A route naming a tab LINE (`:itemId`) acts on that line's tab, whatever `:id` says (the same rule
    // `outlet-scope.js` applies), so the guard judges the tab the line belongs to.
    let orderId = req.params.id;
    if (req.params.itemId) {
      const line = await db.table('pos_order_items').where({ id: req.params.itemId }).first('pos_order_id');
      if (line) orderId = line.pos_order_id;
    }
    const order = await db.table('pos_orders').where({ id: orderId }).first('outlet_id');
    if (!order) return next(); // the handler answers "not found" in its own words
    const outlet = await db.table('pos_outlets').where({ id: order.outlet_id }).first('name', 'type');
    if (isSupermarketOutlet(outlet)) return next(new SupermarketOutletNotARegisterError(outlet.name));
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { refuseSupermarketTab };
