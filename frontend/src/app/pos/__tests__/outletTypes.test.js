import { describe, it, expect } from 'vitest';
import { receivingOutlets, canReceiveAt, isSupermarketOutlet } from '../outletTypes.js';

const bar = { id: '1', name: 'Main Bar', type: 'bar' };
const store = { id: '2', name: 'Main Store', type: 'store' };
const mart = { id: '3', name: 'Mini Mart', type: 'supermarket' };

describe('receivingOutlets', () => {
  it('with a store room, offers the store and any supermarket, never a bar', () => {
    expect(receivingOutlets([bar, store, mart]).map((o) => o.id)).toEqual(['2', '3']);
    expect(canReceiveAt([bar, store, mart], '3')).toBe(true);
    expect(canReceiveAt([bar, store, mart], '1')).toBe(false);
  });

  it('with no store room, every outlet keeps receiving', () => {
    expect(receivingOutlets([bar, mart]).map((o) => o.id)).toEqual(['1', '3']);
  });

  it('knows a supermarket outlet', () => {
    expect(isSupermarketOutlet(mart)).toBe(true);
    expect(isSupermarketOutlet(bar)).toBe(false);
    expect(isSupermarketOutlet(null)).toBe(false);
  });
});
