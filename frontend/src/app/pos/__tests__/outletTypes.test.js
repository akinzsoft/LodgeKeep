import { describe, it, expect } from 'vitest';
import { receivingOutlets, canReceiveAt, isSupermarketOutlet, registerOutlets, userCanOperateRegister } from '../outletTypes.js';

const bar = { id: '1', name: 'Main Bar', type: 'bar' };
const store = { id: '2', name: 'Main Store', type: 'store' };
const mart = { id: '3', name: 'Mini Mart', type: 'supermarket' };

describe('receivingOutlets', () => {
  it('with a store room, offers only the store (a supermarket restocks by request, like a bar)', () => {
    expect(receivingOutlets([bar, store, mart]).map((o) => o.id)).toEqual(['2']);
    expect(canReceiveAt([bar, store, mart], '3')).toBe(false);
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

describe('registerOutlets', () => {
  it('leaves out stores and supermarkets, keeps every other type', () => {
    const restaurant = { id: '4', name: 'Restaurant', type: 'restaurant' };
    expect(registerOutlets([bar, store, mart, restaurant]).map((o) => o.id)).toEqual(['1', '4']);
  });
});

describe('userCanOperateRegister', () => {
  it('is false for a user assigned only to a supermarket (or a supermarket and a store)', () => {
    expect(userCanOperateRegister([bar, store, mart], { restricted: true, outletIds: ['3'] })).toBe(false);
    expect(userCanOperateRegister([bar, store, mart], { restricted: true, outletIds: [3, 2] })).toBe(false);
  });

  it('is true for anyone assigned to a bar, restaurant or room-service outlet', () => {
    expect(userCanOperateRegister([bar, store, mart], { restricted: true, outletIds: ['1'] })).toBe(true);
    expect(userCanOperateRegister([bar, mart], { restricted: true, outletIds: ['3', '1'] })).toBe(true);
    expect(userCanOperateRegister([{ id: '5', name: 'Room service', type: 'room_service' }, mart], { restricted: true, outletIds: ['5'] })).toBe(true);
  });

  it('for an unrestricted user depends on whether the property has any Register outlet', () => {
    expect(userCanOperateRegister([bar, mart], { restricted: false, outletIds: null })).toBe(true);
    expect(userCanOperateRegister([store, mart], { restricted: false, outletIds: null })).toBe(false);
  });

  it('ignores an archived outlet', () => {
    expect(userCanOperateRegister([{ ...bar, status: 'archived' }, mart], { restricted: false, outletIds: null })).toBe(false);
  });
});
