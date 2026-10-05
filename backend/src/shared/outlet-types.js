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

/**
 * `supermarket` is the second type with behaviour: it is a retail outlet that
 * takes its own opening stock (receive and stock-take are not routed through
 * a store room) and taxes its sales under their own VAT row. Scoped to this
 * one type: bars, restaurants and every other type are unchanged.
 */
const SUPERMARKET_OUTLET_TYPE = 'supermarket';
const SUPERMARKET_TAX_CHARGE_TYPE = 'supermarket_sale';

function isSupermarketOutlet(outlet) {
  return Boolean(outlet) && outlet.type === SUPERMARKET_OUTLET_TYPE;
}

/** The charge type a sale at this outlet is taxed under (see cashiering/tax-engine.js). */
function taxChargeTypeForOutlet(outlet) {
  return isSupermarketOutlet(outlet) ? SUPERMARKET_TAX_CHARGE_TYPE : 'pos_charge';
}

function isPointOfSaleOutlet(outlet) {
  return Boolean(outlet) && outlet.type !== STORE_OUTLET_TYPE;
}

/**
 * An active outlet that sells to hotel guests: a point of sale that is not a supermarket. A category such a
 * outlet carries is on the hotel's menu, so the supermarket never changes a product in it (the product
 * import refuses to file into one, and product editing refuses to edit one).
 */
function isHotelSellingOutlet(outlet) {
  return Boolean(outlet) && outlet.status === 'active' && isPointOfSaleOutlet(outlet) && !isSupermarketOutlet(outlet);
}

module.exports = { isHotelSellingOutlet, STORE_OUTLET_TYPE, SUPERMARKET_OUTLET_TYPE, SUPERMARKET_TAX_CHARGE_TYPE, isPointOfSaleOutlet, isSupermarketOutlet, taxChargeTypeForOutlet };
