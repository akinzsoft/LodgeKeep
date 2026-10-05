/**
 * Outlet types with behaviour attached — the frontend mirror of the
 * backend's `shared/outlet-types.js`. Every other outlet type is a label
 * only; a store holds and issues stock but never sells. The point-of-sale
 * screens (Register, Tickets, Sales, QR codes) leave stores out of their
 * outlet pickers; stock screens keep them, since a store is where stock is
 * received, counted and issued from. The server refuses an order, terminal
 * or QR code at a store regardless of what a screen offers.
 */
export const STORE_OUTLET_TYPE = 'store';

export const SUPERMARKET_OUTLET_TYPE = 'supermarket';

export function isStoreOutlet(outlet) {
  return outlet?.type === STORE_OUTLET_TYPE;
}

/** A supermarket sells under its own VAT row. Its stock rises only by the opening-stock import or a store-approved request/transfer, like any other outlet's (it has no receive or stock-take exemption). */
export function isSupermarketOutlet(outlet) {
  return outlet?.type === SUPERMARKET_OUTLET_TYPE;
}

/** Only the outlets that sell. */
export function pointOfSaleOutlets(outlets) {
  return (outlets ?? []).filter((outlet) => !isStoreOutlet(outlet));
}

/**
 * Where a supplier delivery may be received. Once a property has a store room
 * the store is the ONLY place (stock then reaches a bar or restaurant by a
 * stock request or transfer; receiving there too would count the same goods
 * twice). A property with no store keeps every outlet. The server enforces
 * the same rule (`BUSINESS_RULE_RECEIVE_AT_STORE_ONLY`).
 */
export function receivingOutlets(outlets) {
  const stores = (outlets ?? []).filter(isStoreOutlet);
  return stores.length > 0 ? stores : (outlets ?? []);
}

export function canReceiveAt(outlets, outletId) {
  return receivingOutlets(outlets).some((outlet) => String(outlet.id) === String(outletId));
}
