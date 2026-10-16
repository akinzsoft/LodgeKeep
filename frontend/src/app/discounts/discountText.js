/** Words for discounts and comps, shared by the Register, the Supermarket till and the reports. */

export const KIND_LABELS = { discount: 'Discount', comp: 'Comp' };

export const STATUS_LABELS = {
  pending_approval: 'Waiting for a manager',
  active: 'Applied',
  applied: 'Settled',
  removed: 'Removed',
  expired: 'Expired',
};

/** "10%" or the fixed amount's text; a comp reads "Comp". */
export function describeRule(discount, formatAmount) {
  if (discount.kind === 'comp') return 'Comp (100%)';
  return discount.type === 'percent' ? `${Number(discount.value)}%` : formatAmount(discount.value);
}

/** A reason is allowed for the kind when its own kind is that one or "both". */
export function reasonsFor(reasons, kind) {
  return reasons.filter((reason) => reason.kind === 'both' || reason.kind === kind);
}

/** Text for a value typed in the dialog: a plain decimal with at most 2 places, above zero (the server checks the rest). */
export function isValidDiscountValue(text) {
  const value = String(text ?? '').trim();
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0;
}
