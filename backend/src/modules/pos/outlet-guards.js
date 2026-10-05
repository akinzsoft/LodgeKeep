'use strict';

/**
 * Which outlets the POS Register (and guest QR ordering) may sell at: not a store room (it holds stock,
 * never sells) and not a supermarket (it sells only from the Supermarket screen: gapless receipts, its
 * own VAT row and report). One place, so the Register's routes and QR ordering cannot drift apart.
 */

const { isPointOfSaleOutlet, isSupermarketOutlet } = require('../../shared/outlet-types');
const { StoreOutletNotAPointOfSaleError, SupermarketOutletNotARegisterError } = require('./errors');

function assertRegisterOutlet(outlet) {
  if (!isPointOfSaleOutlet(outlet)) throw new StoreOutletNotAPointOfSaleError(outlet?.name);
  if (isSupermarketOutlet(outlet)) throw new SupermarketOutletNotARegisterError(outlet.name);
}

module.exports = { assertRegisterOutlet };
