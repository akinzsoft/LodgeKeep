'use strict';

/**
 * Outlet types with behaviour attached. `pos_outlets.type` is free text
 * (its migration's own header: a property may run an outlet type no list
 * anticipated), and almost every value is presentation only — a bar and a
 * restaurant sell the same way. `store` is the one exception: a store holds
 * and issues stock (goods received into it, transfers out of it, its own
 * stock takes) but is never a point of sale — no order, terminal, or guest
 * QR ordering may open there. Kept here, not in one module, because both
 * the POS and the QR-ordering services enforce it.
 */

const STORE_OUTLET_TYPE = 'store';

function isPointOfSaleOutlet(outlet) {
  return Boolean(outlet) && outlet.type !== STORE_OUTLET_TYPE;
}

module.exports = { STORE_OUTLET_TYPE, isPointOfSaleOutlet };
