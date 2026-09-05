'use strict';

/**
 * Cashiering's tax engine — ARCHITECTURE.md §12.1, PLAN.md Phase 2.5 (the
 * real folio ledger). Pure, no database — the same "the calculation is a
 * directly unit-testable pure function" shape Phase 1's
 * `resolveEffectiveTax` (`src/modules/setup/service.js`) already established
 * for effective-dating; this module is what actually APPLIES a resolved tax
 * version to a real charge amount, which Phase 1 deliberately left
 * unbuilt — no charge-type taxonomy existed anywhere in this schema until
 * this module's `applies_to` matching below (`taxes` migration's own
 * header: "no fixed taxonomy exists yet (Phase 2)").
 *
 * `resolveApplicableTaxVersions` calls Phase 1's own `resolveEffectiveTax`
 * once per distinct `tax_code` at the property, so a rate change made
 * yesterday still resolves to the version effective on THIS charge's
 * `business_date` — the exact historical-reproducibility rule §12.1 exists
 * for. `computeChargeWithTax` is the multi-tax, compound, inclusive/exclusive
 * calculation itself, taking already-resolved versions so a caller (night
 * audit, replaying a past business_date) never needs to re-derive them.
 *
 * ── SCOPE, FLAGGED ───────────────────────────────────────────────────────
 *
 * NOT built: per-guest/company tax exemptions (ARCHITECTURE.md §12.1 names
 * these; no company-profile concept exists in this codebase at all — see
 * the `guests` migration's own "minimal stub" reasoning) and discount
 * interaction with the taxable base (no discount/comp line type exists yet
 * either). Both are real §12.1 scope, deliberately deferred rather than
 * guessed at, the same "flagged stub, not invented behaviour" discipline
 * every other phase in this codebase has followed.
 */

const { percentOfMoney, sumMoney, negateMoney, inclusiveTaxPortion } = require('../../shared/money');
const { resolveEffectiveTax } = require('../setup/service');

/**
 * One resolved tax version per distinct `tax_code` at the property,
 * effective on `businessDate` and applicable to `chargeType`. `applies_to`
 * is free text (Phase 1's own deliberate choice, see the `taxes` migration's
 * header): `'all'` always matches; anything else must equal `chargeType`
 * exactly — no fuzzy taxonomy, no partial match.
 *
 * @param {Array<object>} allTaxRows  Every tax version at the property, any tax_code, any date — the property's whole `taxes` table.
 * @param {string} businessDate  'YYYY-MM-DD'.
 * @param {string} chargeType  e.g. 'room_charge', 'pos_charge', 'adjustment'.
 * @returns {Array<object>} Resolved versions, sorted by `priority` ascending (ARCHITECTURE.md §12.1: "priority fixes the order").
 */
function resolveApplicableTaxVersions({ allTaxRows, businessDate, chargeType }) {
  const versionsByCode = new Map();
  for (const row of allTaxRows) {
    if (!versionsByCode.has(row.tax_code)) versionsByCode.set(row.tax_code, []);
    versionsByCode.get(row.tax_code).push(row);
  }

  const resolved = [];
  for (const versions of versionsByCode.values()) {
    const version = resolveEffectiveTax(versions, businessDate);
    if (!version) continue;
    if (version.applies_to !== 'all' && version.applies_to !== chargeType) continue;
    resolved.push(version);
  }
  return resolved.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/**
 * Applies every resolved tax version to one charge, in priority order.
 *
 * `is_compound`: the taxable base is the running GROSS total so far (base +
 * every prior tax's contribution) rather than the original charge amount —
 * ARCHITECTURE.md §12.1: "does this tax apply to the base amount, or to
 * (base + prior taxes)."
 *
 * `is_inclusive`: the taxable base already CONTAINS this tax — the amount is
 * back-calculated (`src/shared/money.js`'s `inclusiveTaxPortion`) and
 * deducted from the NET (room-revenue) side rather than added to the gross
 * total, which was already inclusive of it. `is_exclusive` (the common case)
 * adds the tax on top of the running gross total instead.
 *
 * `calculation_method: 'flat_amount'` taxes are always applied exclusively,
 * regardless of their own `is_inclusive`/`is_compound` flags: §12.1's
 * inclusive/compound rules are defined in terms of a PERCENTAGE of a base,
 * and a flat amount has no base to be inclusive-of or compound-against —
 * this deliberately does not extend those semantics to flat taxes rather
 * than inventing an unstated rule for them.
 *
 * @param {string} baseAmount  The charge's own pre-tax amount, as quoted/booked.
 * @param {Array<object>} taxVersions  Resolved, priority-sorted (see `resolveApplicableTaxVersions`).
 * @returns {{netAmount: string, grossAmount: string, taxLines: Array<{taxCode: string, name: string, amount: string}>}}
 */
function computeChargeWithTax({ baseAmount, taxVersions }) {
  let netSoFar = baseAmount;
  let grossSoFar = baseAmount;
  const taxLines = [];

  for (const tax of taxVersions) {
    if (tax.calculation_method === 'flat_amount') {
      grossSoFar = sumMoney([grossSoFar, tax.rate]);
      taxLines.push({ taxCode: tax.tax_code, name: tax.name, amount: tax.rate });
      continue;
    }

    const taxableBase = tax.is_compound ? grossSoFar : baseAmount;

    if (tax.is_inclusive) {
      const amount = inclusiveTaxPortion(taxableBase, tax.rate);
      netSoFar = sumMoney([netSoFar, negateMoney(amount)]);
      taxLines.push({ taxCode: tax.tax_code, name: tax.name, amount });
    } else {
      const amount = percentOfMoney(taxableBase, tax.rate);
      grossSoFar = sumMoney([grossSoFar, amount]);
      taxLines.push({ taxCode: tax.tax_code, name: tax.name, amount });
    }
  }

  return { netAmount: netSoFar, grossAmount: grossSoFar, taxLines };
}

module.exports = { resolveApplicableTaxVersions, computeChargeWithTax };
