'use strict';

/**
 * HOTEL REGRESSION GATE. The supermarket work added an exact-match charge-type
 * rule to `resolveApplicableTaxVersions`. This proves hotel tax is untouched:
 * a frozen, verbatim copy of the ORIGINAL resolver (LEGACY_resolve below) and
 * the live one are run over the same tax tables, charge types, dates and
 * amounts, and must give identical resolved versions, taxLines, net and gross.
 * Only the new 'supermarket_sale' charge type may differ.
 */

const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../../src/modules/cashiering/tax-engine');
const { resolveEffectiveTax } = require('../../src/modules/setup/service');

// Verbatim copy of the pre-supermarket rule. Do NOT edit to match the new code.
function LEGACY_resolve({ allTaxRows, businessDate, chargeType }) {
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

const base = {
  effective_from: '2026-01-01', effective_to: null, priority: 0,
  is_compound: false, is_inclusive: false, calculation_method: 'percentage', applies_to: 'all',
};
const row = (o) => ({ ...base, name: o.tax_code, ...o });

const TABLES = {
  exclusiveAll: [row({ tax_code: 'VAT', rate: '7.5000' })],
  inclusiveAll: [row({ tax_code: 'VAT', rate: '7.5000', is_inclusive: true })],
  inclusivePos: [row({ tax_code: 'VAT', rate: '7.5000', is_inclusive: true, applies_to: 'pos_charge' })],
  compound: [
    row({ tax_code: 'SERVICE', rate: '10.0000', priority: 0 }),
    row({ tax_code: 'VAT', rate: '7.5000', priority: 1, is_compound: true }),
  ],
  flat: [row({ tax_code: 'LEVY', rate: '150.00', calculation_method: 'flat_amount', applies_to: 'room_charge' })],
  mixedScopes: [
    row({ tax_code: 'VAT', rate: '7.5000', applies_to: 'all', priority: 0 }),
    row({ tax_code: 'TOURISM', rate: '2.0000', applies_to: 'room_charge', priority: 1 }),
    row({ tax_code: 'POSFEE', rate: '1.0000', applies_to: 'pos_charge', priority: 2 }),
    row({ tax_code: 'INCL', rate: '5.0000', applies_to: 'all', is_inclusive: true, priority: 3 }),
    row({ tax_code: 'FLAT', rate: '25.00', calculation_method: 'flat_amount', applies_to: 'all', priority: 4 }),
  ],
  rateChange: [
    row({ tax_code: 'VAT', rate: '5.0000', effective_to: '2026-05-31' }),
    row({ tax_code: 'VAT', rate: '7.5000', effective_from: '2026-06-01' }),
  ],
  empty: [],
};
const CHARGE_TYPES = ['room_charge', 'pos_charge', 'adjustment', 'tip', 'anything_else'];
const DATES = ['2026-03-01', '2026-06-01', '2026-12-31'];
const AMOUNTS = ['0.00', '1.00', '19.99', '1250.00', '99999.99'];

describe('hotel tax is byte-identical to the original rule', () => {
  for (const [tableName, allTaxRows] of Object.entries(TABLES)) {
    it(`${tableName}: every charge type, date and amount`, () => {
      let compared = 0;
      for (const chargeType of CHARGE_TYPES) {
        for (const businessDate of DATES) {
          const oldV = LEGACY_resolve({ allTaxRows, businessDate, chargeType });
          const newV = resolveApplicableTaxVersions({ allTaxRows, businessDate, chargeType });
          expect(newV).toEqual(oldV);
          for (const baseAmount of AMOUNTS) {
            expect(computeChargeWithTax({ baseAmount, taxVersions: newV })).toEqual(computeChargeWithTax({ baseAmount, taxVersions: oldV }));
            compared += 1;
          }
        }
      }
      expect(compared).toBe(CHARGE_TYPES.length * DATES.length * AMOUNTS.length);
    });
  }

  it("a hotel 'all' row still applies to hotel POS and room charges (guards against an over-eager rule)", () => {
    for (const chargeType of ['pos_charge', 'room_charge']) {
      const v = resolveApplicableTaxVersions({ allTaxRows: TABLES.exclusiveAll, businessDate: '2026-03-01', chargeType });
      expect(v.map((t) => t.tax_code)).toEqual(['VAT']);
    }
  });
});

describe('supermarket_sale exact-match rule', () => {
  const SUPER = row({ tax_code: 'SUPER_VAT', rate: '7.5000', applies_to: 'supermarket_sale' });
  const HOTEL_ALL = row({ tax_code: 'VAT', rate: '7.5000', applies_to: 'all' });
  const codes = (allTaxRows, chargeType) => resolveApplicableTaxVersions({ allTaxRows, businessDate: '2026-03-01', chargeType }).map((t) => t.tax_code);

  it("a hotel 'all' row never applies; only the supermarket row does", () => {
    expect(codes([HOTEL_ALL, SUPER], 'supermarket_sale')).toEqual(['SUPER_VAT']);
  });
  it('with no supermarket row a supermarket sale is untaxed, not hotel-taxed', () => {
    expect(codes([HOTEL_ALL], 'supermarket_sale')).toEqual([]);
    const taxLines = computeChargeWithTax({ baseAmount: '100.00', taxVersions: [] });
    expect(taxLines.grossAmount).toBe('100.00');
  });
  it('a supermarket row never applies to a hotel charge type', () => {
    for (const chargeType of ['pos_charge', 'room_charge', 'adjustment']) {
      expect(codes([HOTEL_ALL, SUPER], chargeType)).toEqual(['VAT']);
    }
  });
  it('an inclusive supermarket row backs the tax out of the line', () => {
    const inc = { ...SUPER, is_inclusive: true };
    const v = resolveApplicableTaxVersions({ allTaxRows: [HOTEL_ALL, inc], businessDate: '2026-03-01', chargeType: 'supermarket_sale' });
    const r = computeChargeWithTax({ baseAmount: '107.50', taxVersions: v });
    expect(r.taxLines).toEqual([{ taxCode: 'SUPER_VAT', name: 'SUPER_VAT', amount: '7.50' }]);
    expect(r.netAmount).toBe('100.00');
  });
});
