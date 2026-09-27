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

export function isStoreOutlet(outlet) {
  return outlet?.type === STORE_OUTLET_TYPE;
}

/** Only the outlets that sell. */
export function pointOfSaleOutlets(outlets) {
  return (outlets ?? []).filter((outlet) => !isStoreOutlet(outlet));
}
