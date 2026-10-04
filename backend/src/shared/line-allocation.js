'use strict';

/**
 * Splits an exact money total across weighted lines so the parts add up to
 * the total to the cent (largest-remainder). Used to show each line's net and
 * tax when a VAT row is tax-INCLUSIVE: the settlement stores only the net
 * `subtotal` and the `tax_amount`, while each line's own price is gross.
 *
 * `allocateCents(totalCents, weights)`: BigInt cents, BigInt weights >= 0.
 * With a zero weight sum the whole total goes to the first line.
 */

const { toCents, fromCents } = require('./money');

function allocateCents(totalCents, weights) {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (weights.length === 0) return [];
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? totalCents : 0n));
  const base = weights.map((w) => (totalCents * w) / sum);
  let remainder = totalCents - base.reduce((a, b) => a + b, 0n);
  // Hand out the leftover cents to the lines with the biggest fractional parts (ties: earlier line).
  const order = weights
    .map((w, i) => ({ i, frac: (totalCents * w) % sum }))
    .sort((a, b) => (a.frac === b.frac ? a.i - b.i : a.frac > b.frac ? -1 : 1));
  const out = [...base];
  for (let k = 0; remainder > 0n; k = (k + 1) % order.length) {
    out[order[k].i] += 1n;
    remainder -= 1n;
  }
  return out;
}

/**
 * Per-line net and tax for one settlement. `lineTotals`: gross line amounts
 * (decimal strings); `subtotal`/`taxAmount`: the settlement's own figures.
 * Returns `[{net, tax}]` whose sums equal `subtotal` and `taxAmount` exactly.
 * With an exclusive tax the net equals the gross and the tax is spread
 * pro rata; with an inclusive one the net is scaled down to the settlement's.
 */
function allocateLineNetAndTax({ lineTotals, subtotal, taxAmount }) {
  const weights = lineTotals.map((value) => toCents(value));
  const gross = weights.reduce((a, w) => a + w, 0n);
  const nets = allocateCents(toCents(subtotal), weights);
  // Inclusive tax: the lines' own prices already contain the tax (gross = net + tax),
  // so each line's tax is simply what its net lacks of its price.
  if (toCents(subtotal) + toCents(taxAmount) === gross) {
    return lineTotals.map((_, i) => ({ net: fromCents(nets[i]), tax: fromCents(weights[i] - nets[i]) }));
  }
  // Exclusive (or no) tax: the net is the price; the tax is spread in proportion.
  const taxes = allocateCents(toCents(taxAmount), weights);
  return lineTotals.map((_, i) => ({ net: fromCents(nets[i]), tax: fromCents(taxes[i]) }));
}

module.exports = { allocateCents, allocateLineNetAndTax };
