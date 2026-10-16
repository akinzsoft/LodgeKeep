'use strict';

/**
 * Discounts, comps and vouchers (PR 1): the pure arithmetic every priced check shares. A discount is subtracted from
 * the item base BEFORE the tax engine runs, so VAT and service charge follow the discounted amount. With no
 * discounts the result is exactly today's base, which is what keeps the hotel golden snapshots byte-identical.
 */

const { applyDiscounts, isWithinPercentLimit, groupKeyOf } = require('../../src/shared/discount-pricing');
const { assertDiscountInput, DEFAULT_MAX_DISCOUNT_AMOUNT } = require('../../src/shared/discount-input');

const item = (id, unitPrice, quantity = 1, splitGroup = null, modifiers = []) => ({ id, unit_price: unitPrice, quantity, split_group: splitGroup, modifiers });

describe('applyDiscounts', () => {
  test('no discounts: the base is exactly the item total and no group carries any discount', () => {
    const result = applyDiscounts({ items: [item(1, '10.00', 2), item(2, '5.50')], discounts: [] });
    expect(result.grossTotal).toBe('25.50');
    expect(result.discountTotal).toBe('0.00');
    expect(result.baseTotal).toBe('25.50');
    expect(result.groups[groupKeyOf(null)]).toEqual({ gross: '25.50', discount: '0.00', base: '25.50', parts: [] });
    expect(result.discounts).toEqual([]);
  });

  test('a percent discount on the order rounds half-up to the cent', () => {
    const result = applyDiscounts({ items: [item(1, '10.05')], discounts: [{ id: 'd1', scope: 'order', type: 'percent', value: '10.00' }] });
    expect(result.discounts).toEqual([{ discountId: 'd1', scope: 'order', amount: '1.01', baseBefore: '10.05' }]); // 1.005 -> 1.01
    expect(result.baseTotal).toBe('9.04');
  });

  test('a fixed discount is taken off as entered and never exceeds the value it applies to', () => {
    const fixed = applyDiscounts({ items: [item(1, '10.00')], discounts: [{ id: 'd1', scope: 'order', type: 'fixed', value: '3.00' }] });
    expect(fixed.baseTotal).toBe('7.00');
    const capped = applyDiscounts({ items: [item(1, '10.00')], discounts: [{ id: 'd1', scope: 'order', type: 'fixed', value: '50.00' }] });
    expect(capped.discounts[0].amount).toBe('10.00');
    expect(capped.baseTotal).toBe('0.00');
  });

  test('a line discount applies to that line only, on its whole quantity', () => {
    const result = applyDiscounts({
      items: [item(1, '10.00', 3), item(2, '4.00')],
      discounts: [{ id: 'd1', scope: 'line', type: 'percent', value: '50.00', pos_order_item_id: 1 }],
    });
    expect(result.discounts).toEqual([{ discountId: 'd1', scope: 'line', amount: '15.00', baseBefore: '30.00' }]);
    expect(result.baseTotal).toBe('19.00');
  });

  test('a line discount for an item that is no longer on the check (voided) takes nothing', () => {
    const result = applyDiscounts({ items: [item(2, '4.00')], discounts: [{ id: 'd1', scope: 'line', type: 'fixed', value: '1.00', pos_order_item_id: 1 }] });
    expect(result.discounts).toEqual([{ discountId: 'd1', scope: 'line', amount: '0.00', baseBefore: '0.00' }]);
    expect(result.baseTotal).toBe('4.00');
  });

  test('line discounts come first and the order discount applies to what is left', () => {
    const result = applyDiscounts({
      items: [item(1, '100.00'), item(2, '100.00')],
      discounts: [
        { id: 'order', scope: 'order', type: 'percent', value: '10.00' },
        { id: 'line', scope: 'line', type: 'percent', value: '50.00', pos_order_item_id: 1 },
      ],
    });
    const byId = Object.fromEntries(result.discounts.map((d) => [d.discountId, d]));
    expect(byId.line.amount).toBe('50.00');
    expect(byId.order.baseBefore).toBe('150.00');
    expect(byId.order.amount).toBe('15.00');
    expect(result.baseTotal).toBe('135.00');
  });

  test('a 100% comp takes the whole value and the base is exactly zero', () => {
    const result = applyDiscounts({ items: [item(1, '12.34', 2)], discounts: [{ id: 'c', scope: 'order', type: 'percent', value: '100.00' }] });
    expect(result.baseTotal).toBe('0.00');
    expect(result.discountTotal).toBe('24.68');
  });

  test('an order discount is spread across split groups so the shares add up to the cent', () => {
    const result = applyDiscounts({
      items: [item(1, '10.00', 1, 1), item(2, '10.00', 1, 2), item(3, '10.00', 1, 3)],
      discounts: [{ id: 'd1', scope: 'order', type: 'fixed', value: '10.00' }],
    });
    const shares = [1, 2, 3].map((g) => result.groups[groupKeyOf(g)].discount);
    expect(shares.reduce((sum, s) => sum + Math.round(Number(s) * 100), 0)).toBe(1000);
    expect(shares.sort()).toEqual(['3.33', '3.33', '3.34']);
    expect(result.discounts[0].amount).toBe('10.00');
  });

  test('a line discount stays in its own split group', () => {
    const result = applyDiscounts({
      items: [item(1, '10.00', 1, 1), item(2, '10.00', 1, 2)],
      discounts: [{ id: 'd1', scope: 'line', type: 'fixed', value: '4.00', pos_order_item_id: 2 }],
    });
    expect(result.groups[groupKeyOf(1)].discount).toBe('0.00');
    expect(result.groups[groupKeyOf(2)].discount).toBe('4.00');
    expect(result.groups[groupKeyOf(2)].parts).toEqual([{ discountId: 'd1', amount: '4.00', baseBefore: '10.00' }]);
  });

  test('modifiers are part of the line total being discounted', () => {
    const result = applyDiscounts({
      items: [item(1, '10.00', 2, null, [{ name: 'Size', option: 'L', priceDelta: '1.00' }])],
      discounts: [{ id: 'd1', scope: 'line', type: 'percent', value: '10.00', pos_order_item_id: 1 }],
    });
    expect(result.discounts[0].amount).toBe('2.20');
  });

  test('the discount can never make a total negative, whatever the input', () => {
    const result = applyDiscounts({
      items: [item(1, '5.00')],
      discounts: [
        { id: 'a', scope: 'line', type: 'fixed', value: '4.00', pos_order_item_id: 1 },
        { id: 'b', scope: 'order', type: 'fixed', value: '4.00' },
      ],
    });
    expect(result.baseTotal).toBe('0.00');
    expect(result.discountTotal).toBe('5.00');
  });
});

describe('a line discount by product', () => {
  test('covers every unvoided row of the product, across split groups, and the group shares add up', () => {
    const rows = [
      { id: 1, menu_item_id: 'beer', unit_price: '100.00', quantity: 1, split_group: 1, modifiers: [] },
      { id: 2, menu_item_id: 'beer', unit_price: '100.00', quantity: 1, split_group: 2, modifiers: [] },
      { id: 3, menu_item_id: 'beer', unit_price: '100.00', quantity: 1, split_group: 2, modifiers: [] },
      { id: 4, menu_item_id: 'snack', unit_price: '40.00', quantity: 1, split_group: 1, modifiers: [] },
    ];
    const result = applyDiscounts({ items: rows, discounts: [{ id: 'l', scope: 'line', type: 'fixed', value: '10.00', menu_item_id: 'beer' }] });
    expect(result.discounts).toEqual([{ discountId: 'l', scope: 'line', amount: '10.00', baseBefore: '300.00' }]);
    const g1 = result.groups[groupKeyOf(1)];
    const g2 = result.groups[groupKeyOf(2)];
    expect(g1.discount).toBe('3.34'); // a tie in the leftover cent goes to the earlier row
    expect(g2.discount).toBe('6.66');
    expect(g2.parts).toEqual([{ discountId: 'l', amount: '6.66', baseBefore: '200.00' }]);
    expect(result.lines['4'].base).toBe('40.00'); // the snack is untouched
  });

  test('a percent line discount is taken on the product\'s whole line', () => {
    const rows = [
      { id: 1, menu_item_id: 'beer', unit_price: '100.00', quantity: 2, split_group: null, modifiers: [] },
      { id: 2, menu_item_id: 'beer', unit_price: '100.00', quantity: 1, split_group: null, modifiers: [] },
    ];
    const result = applyDiscounts({ items: rows, discounts: [{ id: 'l', scope: 'line', type: 'percent', value: '10', menu_item_id: 'beer' }] });
    expect(result.discounts[0]).toMatchObject({ amount: '30.00', baseBefore: '300.00' });
  });
});

describe('per-line figures', () => {
  test('an order discount is spread over the lines in proportion to what they have left, to the cent', () => {
    const result = applyDiscounts({
      items: [item(1, '100.00'), item(2, '50.00')],
      discounts: [{ id: 'o', scope: 'order', type: 'fixed', value: '10.00' }],
    });
    expect(result.lines['1']).toEqual({ gross: '100.00', base: '93.33' });
    expect(result.lines['2']).toEqual({ gross: '50.00', base: '46.67' });
    expect(Number(result.lines['1'].base) + Number(result.lines['2'].base)).toBeCloseTo(140, 2);
  });

  test('a line discount reduces only its own line', () => {
    const result = applyDiscounts({ items: [item(1, '100.00'), item(2, '50.00')], discounts: [{ id: 'l', scope: 'line', type: 'percent', value: '10', pos_order_item_id: 1 }] });
    expect(result.lines['1'].base).toBe('90.00');
    expect(result.lines['2'].base).toBe('50.00');
  });
});

describe('isWithinPercentLimit', () => {
  test('compares the effective percent exactly, in cents', () => {
    expect(isWithinPercentLimit({ amount: '5.00', base: '100.00', limitPercent: '5.00' })).toBe(true);
    expect(isWithinPercentLimit({ amount: '5.01', base: '100.00', limitPercent: '5.00' })).toBe(false);
    expect(isWithinPercentLimit({ amount: '0.00', base: '0.00', limitPercent: '0.00' })).toBe(true);
    expect(isWithinPercentLimit({ amount: '1.00', base: '0.00', limitPercent: '100.00' })).toBe(false);
  });
});

describe('assertDiscountInput', () => {
  const ok = { scope: 'order', type: 'percent', value: '10' };

  test('accepts plain decimal strings and returns the trimmed value', () => {
    expect(assertDiscountInput({ ...ok, value: ' 12.5 ' })).toMatchObject({ scope: 'order', type: 'percent', value: '12.5' });
    expect(assertDiscountInput({ scope: 'line', type: 'fixed', value: '200' })).toMatchObject({ type: 'fixed', value: '200' });
  });

  test.each([
    ['negative', '-5'],
    ['exponent', '1e2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['separator', '1,000'],
    ['three decimals', '1.005'],
    ['empty', ''],
    ['a JSON number', 10],
    ['null', null],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
  ])('refuses %s', (_label, value) => {
    expect(() => assertDiscountInput({ ...ok, value })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
  });

  test('a percent above 100 is refused and exactly 100 is allowed', () => {
    expect(() => assertDiscountInput({ ...ok, value: '100.01' })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
    expect(assertDiscountInput({ ...ok, value: '100' }).value).toBe('100');
  });

  test('a fixed amount above the ceiling is refused; a garbage or zero env value falls back to the default', () => {
    expect(() => assertDiscountInput({ scope: 'order', type: 'fixed', value: '1000000.01' })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
    expect(DEFAULT_MAX_DISCOUNT_AMOUNT).toBe('1000000.00');
    const original = process.env.MAX_DISCOUNT_AMOUNT;
    try {
      process.env.MAX_DISCOUNT_AMOUNT = '50.00';
      expect(() => assertDiscountInput({ scope: 'order', type: 'fixed', value: '50.01' })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
      expect(assertDiscountInput({ scope: 'order', type: 'fixed', value: '50.00' }).value).toBe('50.00');
      process.env.MAX_DISCOUNT_AMOUNT = 'garbage';
      expect(assertDiscountInput({ scope: 'order', type: 'fixed', value: '60.00' }).value).toBe('60.00');
      process.env.MAX_DISCOUNT_AMOUNT = '0';
      expect(assertDiscountInput({ scope: 'order', type: 'fixed', value: '60.00' }).value).toBe('60.00');
    } finally {
      if (original === undefined) delete process.env.MAX_DISCOUNT_AMOUNT;
      else process.env.MAX_DISCOUNT_AMOUNT = original;
    }
  });

  test('scope and type must be one of the known values', () => {
    expect(() => assertDiscountInput({ ...ok, scope: 'basket' })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
    expect(() => assertDiscountInput({ ...ok, type: 'bogus' })).toThrow(expect.objectContaining({ code: 'VALIDATION_INVALID_DISCOUNT' }));
  });
});
