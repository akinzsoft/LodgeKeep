'use strict';

/**
 * `src/modules/cashiering/tax-engine.js` — ARCHITECTURE.md §12.1, PLAN.md
 * Phase 2.5. Pure-function tests, no database — the same "prove the
 * calculation itself before it ever touches a folio row" discipline
 * `tests/setup/pure-functions.test.js` already established for
 * `resolveEffectiveTax`.
 */

const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../../src/modules/cashiering/tax-engine');

describe('resolveApplicableTaxVersions', () => {
  const VAT_V1 = {
    tax_code: 'VAT',
    name: 'VAT',
    rate: '5.0000',
    effective_from: '2026-01-01',
    effective_to: '2026-05-31',
    applies_to: 'all',
    priority: 0,
    is_compound: false,
    is_inclusive: false,
    calculation_method: 'percentage',
  };
  const VAT_V2 = { ...VAT_V1, rate: '7.5000', effective_from: '2026-06-01', effective_to: null };
  const TOURISM_LEVY = {
    tax_code: 'TOURISM_LEVY',
    name: 'Tourism levy',
    rate: '2.0000',
    effective_from: '2026-01-01',
    effective_to: null,
    applies_to: 'room_charge',
    priority: 1,
    is_compound: false,
    is_inclusive: false,
    calculation_method: 'percentage',
  };

  it('resolves each tax_code to the version effective on the given business_date (historical reproducibility)', () => {
    const resolved = resolveApplicableTaxVersions({
      allTaxRows: [VAT_V1, VAT_V2, TOURISM_LEVY],
      businessDate: '2026-03-15',
      chargeType: 'room_charge',
    });
    expect(resolved.map((t) => `${t.tax_code}@${t.rate}`)).toEqual(['VAT@5.0000', 'TOURISM_LEVY@2.0000']);
  });

  it('a rate change does not alter a resolution for a date before the change', () => {
    const resolved = resolveApplicableTaxVersions({
      allTaxRows: [VAT_V1, VAT_V2],
      businessDate: '2026-07-01',
      chargeType: 'room_charge',
    });
    expect(resolved[0].rate).toBe('7.5000');
  });

  it('excludes a tax whose applies_to does not match the charge type', () => {
    const resolved = resolveApplicableTaxVersions({
      allTaxRows: [TOURISM_LEVY],
      businessDate: '2026-03-15',
      chargeType: 'pos_charge',
    });
    expect(resolved).toEqual([]);
  });

  it('sorts by priority ascending', () => {
    const highPriority = { ...TOURISM_LEVY, tax_code: 'B', priority: 5 };
    const lowPriority = { ...TOURISM_LEVY, tax_code: 'A', priority: 1 };
    const resolved = resolveApplicableTaxVersions({
      allTaxRows: [highPriority, lowPriority],
      businessDate: '2026-03-15',
      chargeType: 'room_charge',
    });
    expect(resolved.map((t) => t.tax_code)).toEqual(['A', 'B']);
  });

  it('a date with no covering version resolves to nothing for that tax_code', () => {
    const resolved = resolveApplicableTaxVersions({
      allTaxRows: [VAT_V1],
      businessDate: '2025-12-31',
      chargeType: 'room_charge',
    });
    expect(resolved).toEqual([]);
  });
});

describe('computeChargeWithTax', () => {
  function pctTax({ code = 'VAT', rate, priority = 0, isCompound = false, isInclusive = false }) {
    return { tax_code: code, name: code, rate, priority, is_compound: isCompound, is_inclusive: isInclusive, calculation_method: 'percentage' };
  }

  it('a single exclusive tax adds on top of the base', () => {
    const result = computeChargeWithTax({ baseAmount: '100.00', taxVersions: [pctTax({ rate: '7.5000' })] });
    expect(result.netAmount).toBe('100.00');
    expect(result.grossAmount).toBe('107.50');
    expect(result.taxLines).toEqual([{ taxCode: 'VAT', name: 'VAT', amount: '7.50' }]);
  });

  it('two exclusive, non-compound taxes both compute against the ORIGINAL base', () => {
    const result = computeChargeWithTax({
      baseAmount: '100.00',
      taxVersions: [pctTax({ code: 'VAT', rate: '5.0000', priority: 0 }), pctTax({ code: 'LEVY', rate: '2.0000', priority: 1 })],
    });
    expect(result.grossAmount).toBe('107.00');
    expect(result.taxLines).toEqual([
      { taxCode: 'VAT', name: 'VAT', amount: '5.00' },
      { taxCode: 'LEVY', name: 'LEVY', amount: '2.00' },
    ]);
  });

  it('a compound tax computes against base + prior tax, not the original base', () => {
    const result = computeChargeWithTax({
      baseAmount: '100.00',
      taxVersions: [
        pctTax({ code: 'VAT', rate: '5.0000', priority: 0 }),
        pctTax({ code: 'LEVY', rate: '10.0000', priority: 1, isCompound: true }),
      ],
    });
    // VAT: 100 * 5% = 5.00, gross now 105.00.
    // LEVY (compound): 105.00 * 10% = 10.50, gross now 115.50.
    expect(result.taxLines).toEqual([
      { taxCode: 'VAT', name: 'VAT', amount: '5.00' },
      { taxCode: 'LEVY', name: 'LEVY', amount: '10.50' },
    ]);
    expect(result.grossAmount).toBe('115.50');
  });

  it('an inclusive tax back-calculates from the quoted price and reduces the net amount, leaving the gross unchanged', () => {
    // A rate of 107.50 inclusive of 7.5% VAT: net should be 100.00, tax 7.50.
    const result = computeChargeWithTax({ baseAmount: '107.50', taxVersions: [pctTax({ rate: '7.5000', isInclusive: true })] });
    expect(result.taxLines).toEqual([{ taxCode: 'VAT', name: 'VAT', amount: '7.50' }]);
    expect(result.netAmount).toBe('100.00');
    expect(result.grossAmount).toBe('107.50');
  });

  it('a flat_amount tax adds a fixed amount regardless of is_compound/is_inclusive', () => {
    const flat = { tax_code: 'CITY_FEE', name: 'City fee', rate: '3.00', priority: 0, is_compound: true, is_inclusive: true, calculation_method: 'flat_amount' };
    const result = computeChargeWithTax({ baseAmount: '100.00', taxVersions: [flat] });
    expect(result.netAmount).toBe('100.00');
    expect(result.grossAmount).toBe('103.00');
    expect(result.taxLines).toEqual([{ taxCode: 'CITY_FEE', name: 'City fee', amount: '3.00' }]);
  });

  it('no applicable taxes leaves the charge untouched', () => {
    const result = computeChargeWithTax({ baseAmount: '42.00', taxVersions: [] });
    expect(result).toEqual({ netAmount: '42.00', grossAmount: '42.00', taxLines: [] });
  });

  it('taxes a negative (refund) base amount the same way as its original charge', () => {
    const result = computeChargeWithTax({ baseAmount: '-100.00', taxVersions: [pctTax({ rate: '7.5000' })] });
    expect(result.grossAmount).toBe('-107.50');
    expect(result.taxLines).toEqual([{ taxCode: 'VAT', name: 'VAT', amount: '-7.50' }]);
  });
});
