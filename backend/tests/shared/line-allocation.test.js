'use strict';

const { allocateCents, allocateLineNetAndTax } = require('../../src/shared/line-allocation');

describe('allocateCents', () => {
  it('splits a total so the parts add up exactly, biggest remainder first', () => {
    const parts = allocateCents(100n, [1n, 1n, 1n]);
    expect(parts).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });
  it('puts everything on the first line when the weights are all zero', () => {
    expect(allocateCents(250n, [0n, 0n])).toEqual([250n, 0n]);
    expect(allocateCents(0n, [])).toEqual([]);
  });
});

describe('allocateLineNetAndTax', () => {
  it('inclusive tax: each line keeps net + tax = its own price, and the lines sum to the settlement', () => {
    // Three 0.99 lines, 7.5% inclusive: 2.97 gross = 2.77 net + 0.20 tax.
    const lines = allocateLineNetAndTax({ lineTotals: ['0.99', '0.99', '0.99'], subtotal: '2.77', taxAmount: '0.20' });
    expect(lines).toEqual([
      { net: '0.93', tax: '0.06' },
      { net: '0.92', tax: '0.07' },
      { net: '0.92', tax: '0.07' },
    ]);
  });

  it('exclusive tax: the net is the price and the tax is spread in proportion', () => {
    const lines = allocateLineNetAndTax({ lineTotals: ['10.00', '30.00'], subtotal: '40.00', taxAmount: '3.00' });
    expect(lines).toEqual([
      { net: '10.00', tax: '0.75' },
      { net: '30.00', tax: '2.25' },
    ]);
  });

  it('no tax: the net is the price', () => {
    expect(allocateLineNetAndTax({ lineTotals: ['5.00', '7.00'], subtotal: '12.00', taxAmount: '0.00' })).toEqual([
      { net: '5.00', tax: '0.00' },
      { net: '7.00', tax: '0.00' },
    ]);
  });
});
