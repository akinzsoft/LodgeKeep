/**
 * Exact decimal money arithmetic — ARCHITECTURE.md §1/§12: "Money is exact,
 * always... Never float, anywhere." Nothing in this frontend had needed to
 * SUM or MULTIPLY money values before PLAN.md Phase 4's POS Register tab —
 * every other screen only formats one already-computed decimal string from
 * the API (`shared/format/money.jsx`'s `Money`), never aggregates several
 * client-side. This is that first exact-arithmetic helper, ported directly
 * from the backend's own `backend/src/shared/money.js` (same BigInt-cents
 * conversion, same behavior) rather than reaching for `Number(a) * b`,
 * which is exactly the float-precision risk this codebase's own principle
 * rules out.
 */

function toCents(decimalString) {
  const [whole, fraction = ''] = String(decimalString).split('.');
  const paddedFraction = `${fraction}00`.slice(0, 2);
  const negative = whole.startsWith('-');
  const wholeAbs = negative ? whole.slice(1) : whole;
  const cents = BigInt(wholeAbs || '0') * 100n + BigInt(paddedFraction || '0');
  return negative ? -cents : cents;
}

function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const wholePart = abs / 100n;
  const fractionPart = abs % 100n;
  return `${negative ? '-' : ''}${wholePart}.${fractionPart.toString().padStart(2, '0')}`;
}

/** Sums an array of DECIMAL-as-string money values exactly, returning a 2-decimal string. `[]` sums to '0.00'. */
export function sumMoney(values) {
  const totalCents = values.reduce((total, value) => total + toCents(value), 0n);
  return fromCents(totalCents);
}

/** Multiplies a DECIMAL-as-string money value by a non-negative integer quantity, exactly. */
export function multiplyMoney(amount, quantity) {
  return fromCents(toCents(amount) * BigInt(quantity));
}

/**
 * The Register redesign's "Service %" input needs a genuinely non-integer
 * multiplier — `multiplyMoney` above deliberately only accepts a whole
 * quantity. Ported to match `backend/src/shared/money.js`'s own
 * `percentOfMoney` exactly — same 4-decimal-place rate scaling (matching
 * `taxes.rate`'s real column precision there, not an arbitrary frontend
 * choice) and the same round-half-up formula, computed entirely in scaled
 * BigInt integers, never a float division.
 *
 * Code-review fix: an earlier draft here scaled the rate to only 2 decimal
 * places and silently TRUNCATED (not rounded) anything beyond that — e.g.
 * "5.999" silently became "5.99", a real, if narrow, discrepancy against
 * this function's own "matches the backend" claim. `frontend/src/shared/
 * __tests__/money.test.js` now proves a 4-decimal-place rate rounds
 * correctly instead of truncating.
 */
export function percentOfMoney(amount, percent) {
  const amountCents = toCents(amount);
  const [rateWhole, rateFraction = ''] = String(percent || '0').split('.');
  const rateScaled = BigInt(rateWhole || '0') * 10000n + BigInt(`${rateFraction}0000`.slice(0, 4) || '0');
  const numerator = amountCents * rateScaled;
  const denominator = 100n * 10000n;
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const roundedAbs = (absNumerator * 2n + denominator) / (2n * denominator);
  return fromCents(negative ? -roundedAbs : roundedAbs);
}
