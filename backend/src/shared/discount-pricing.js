'use strict';

/**
 * Prices a check with its discounts. The discount comes off the item base BEFORE the tax engine runs, so VAT is worked
 * out on the discounted amount and the service charge follows the net after discount (Nigerian invoice practice: a
 * trade discount shown on the invoice reduces the taxable value). With no discounts every figure equals the plain item
 * total, which keeps checks without a discount, and the hotel golden snapshots, exactly as they were.
 *
 * Order of calculation: line discounts first, each on its own line; then the order-level discounts on what is left,
 * spread across the split groups by largest remainder so the shares add up to the cent. A discount never takes more
 * than the value it applies to, so a total can never go negative. Percent amounts round half-up (same rule as the
 * service charge). Pure: cents arithmetic only, no database.
 *
 * `items`: unvoided check lines `{id, split_group, unit_price, quantity, modifiers}`.
 * `discounts`: ACTIVE discounts `{id, scope, type, value, max_amount?, menu_item_id | pos_order_item_id}`; a pending one is never passed in.
 */

const { toCents, fromCents, percentOfMoney } = require('./money');
const { computeItemLineTotal } = require('./pos-pricing');
const { allocateCents } = require('./line-allocation');

function groupKeyOf(splitGroup) {
  return splitGroup === null || splitGroup === undefined ? 'null' : String(splitGroup);
}

/**
 * What one discount takes off `baseCents`: a percent rounds half-up, a fixed amount is capped at the base. A discount a
 * manager approved carries `max_amount`, the amount it came to when approved; it never takes more than that, so items
 * added to the check afterwards are paid for in full (a comp stays the comp that was approved, not the whole check).
 */
function amountOffCents(discount, baseCents) {
  if (baseCents <= 0n) return 0n;
  let wanted = discount.type === 'percent' ? toCents(percentOfMoney(fromCents(baseCents), discount.value)) : toCents(discount.value);
  if (discount.max_amount !== null && discount.max_amount !== undefined) {
    const ceiling = toCents(String(discount.max_amount));
    if (wanted > ceiling) wanted = ceiling;
  }
  return wanted > baseCents ? baseCents : wanted;
}

function applyDiscounts({ items, discounts }) {
  const lineCents = new Map(items.map((item) => [String(item.id), toCents(computeItemLineTotal(item))]));
  const groupOfItem = new Map(items.map((item) => [String(item.id), groupKeyOf(item.split_group)]));
  const remaining = new Map(lineCents);

  const groups = {};
  const group = (key) => (groups[key] ??= { gross: 0n, discount: 0n, parts: [] });
  for (const item of items) group(groupKeyOf(item.split_group)).gross += lineCents.get(String(item.id));

  const results = [];

  // A line discount covers a PRODUCT's line on the check: every unvoided row of that product (`menu_item_id`), or one
  // specific row (`pos_order_item_id`). Its amount is spread over those rows by what each has left.
  const lineMatches = (item, discount) => (discount.menu_item_id ? String(item.menu_item_id) === String(discount.menu_item_id) : String(item.id) === String(discount.pos_order_item_id));
  for (const discount of discounts.filter((d) => d.scope === 'line')) {
    const targets = items.filter((item) => lineMatches(item, discount));
    const weights = targets.map((item) => remaining.get(String(item.id)));
    const base = weights.reduce((sum, weight) => sum + weight, 0n);
    const amount = amountOffCents(discount, base);
    if (amount > 0n) {
      const shares = allocateCents(amount, weights);
      const perGroup = new Map();
      targets.forEach((item, index) => {
        remaining.set(String(item.id), weights[index] - shares[index]);
        const key = groupKeyOf(item.split_group);
        const entry = perGroup.get(key) ?? { amount: 0n, base: 0n };
        entry.amount += shares[index];
        entry.base += weights[index];
        perGroup.set(key, entry);
      });
      for (const [key, entry] of perGroup) {
        if (entry.amount === 0n) continue;
        group(key).discount += entry.amount;
        group(key).parts.push({ discountId: discount.id, amount: fromCents(entry.amount), baseBefore: fromCents(entry.base) });
      }
    }
    results.push({ discountId: discount.id, scope: 'line', amount: fromCents(amount), baseBefore: fromCents(base) });
  }

  for (const discount of discounts.filter((d) => d.scope === 'order')) {
    const groupBases = {};
    for (const item of items) {
      const key = groupKeyOf(item.split_group);
      groupBases[key] = (groupBases[key] ?? 0n) + remaining.get(String(item.id));
    }
    const keys = Object.keys(groupBases);
    const base = keys.reduce((sum, key) => sum + groupBases[key], 0n);
    const amount = amountOffCents(discount, base);
    if (amount > 0n) {
      const shares = allocateCents(amount, keys.map((key) => groupBases[key]));
      keys.forEach((key, index) => {
        if (shares[index] === 0n) return;
        group(key).discount += shares[index];
        group(key).parts.push({ discountId: discount.id, amount: fromCents(shares[index]), baseBefore: fromCents(groupBases[key]) });
      });
      // Each group's share is spread over its own lines in proportion to what they have left, so a later order
      // discount (and the receipt's per-line figures) see the net.
      keys.forEach((key, index) => {
        if (shares[index] === 0n) return;
        const members = items.filter((item) => groupKeyOf(item.split_group) === key);
        const lineShares = allocateCents(shares[index], members.map((item) => remaining.get(String(item.id))));
        members.forEach((item, position) => remaining.set(String(item.id), remaining.get(String(item.id)) - lineShares[position]));
      });
    }
    results.push({ discountId: discount.id, scope: 'order', amount: fromCents(amount), baseBefore: fromCents(base) });
  }

  const out = {};
  let gross = 0n;
  let discountTotal = 0n;
  for (const [key, value] of Object.entries(groups)) {
    out[key] = { gross: fromCents(value.gross), discount: fromCents(value.discount), base: fromCents(value.gross - value.discount), parts: value.parts };
    gross += value.gross;
    discountTotal += value.discount;
  }
  const lines = {};
  for (const item of items) {
    const id = String(item.id);
    lines[id] = { gross: fromCents(lineCents.get(id)), base: fromCents(remaining.get(id)) };
  }
  return { grossTotal: fromCents(gross), discountTotal: fromCents(discountTotal), baseTotal: fromCents(gross - discountTotal), groups: out, lines, discounts: results };
}

/** True when `amount` is at most `limitPercent` percent of `base`, compared exactly in cents (no rounding). */
function isWithinPercentLimit({ amount, base, limitPercent }) {
  const amountCents = toCents(amount);
  const baseCents = toCents(base);
  if (amountCents === 0n) return true;
  if (baseCents <= 0n) return false;
  const [whole, fraction = ''] = String(limitPercent).split('.');
  const limitScaled = BigInt(whole || '0') * 100n + BigInt(`${fraction}00`.slice(0, 2) || '0');
  return amountCents * 10000n <= limitScaled * baseCents;
}

/** `amount` as a percent of `base`, rounded half-up to 2 decimals ('0.00' for an empty base). */
function effectivePercent({ amount, base }) {
  const baseCents = toCents(base);
  if (baseCents <= 0n) return '0.00';
  const scaled = (toCents(amount) * 20000n + baseCents) / (2n * baseCents); // percent x 100, half-up
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
}

module.exports = { applyDiscounts, isWithinPercentLimit, effectivePercent, groupKeyOf };
