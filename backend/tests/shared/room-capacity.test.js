'use strict';

/**
 * `roomCountsTowardCapacity` re-expresses in JavaScript what
 * `livePhysicalCount` (`shared/room-availability.js`) expresses in SQL —
 * "does this room count toward a type's sellable capacity on this date".
 * The room-management capacity guard is only trustworthy if the two can
 * never drift apart, so this pins them against each other over every state a
 * room can be in.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { scopedDb } = require('../../src/db');
const { contextFromSession } = require('../../src/modules/tenancy');
const { livePhysicalCount } = require('../../src/shared/room-availability');
const { roomCountsTowardCapacity } = require('../../src/shared/room-capacity');

describe('room-capacity parity with livePhysicalCount', () => {
  const tx = useTestApp();
  let ctx;
  let typeId;
  let accessor;

  beforeAll(async () => {
    ctx = await seedTwoTenants(tx.trx);
    const tenant = ctx.a;
    const propertyId = tenant.properties[0].id;
    [typeId] = await tx.trx('room_types').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      code: 'PARITY',
      name: 'Parity',
      default_occupancy: 2,
      base_rate: '10.00',
    });
    const insert = async (roomNumber, extra = {}) => {
      const [id] = await tx.trx('rooms').insert({ tenant_id: tenant.id, property_id: propertyId, room_type_id: typeId, room_number: roomNumber, ...extra });
      return id;
    };
    const oooId = await insert('P-OOO');
    await insert('P-ACTIVE');
    await insert('P-ARCHIVED', { status: 'archived' });
    await insert('P-OOS', { status: 'out_of_service' });
    await insert('P-DISCREPANT', { has_discrepancy: true });
    await tx.trx('out_of_order_periods').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      room_id: oooId,
      type: 'ooo',
      reason: 'parity',
      start_date: '2027-03-10',
      end_date: '2027-03-12',
      created_by_user_id: tenant.users[0].id,
    });
    accessor = scopedDb().for(contextFromSession({ tenantId: tenant.id, userId: tenant.users[0].id, propertyId }));
  });

  it.each(['2027-03-09', '2027-03-10', '2027-03-12', '2027-03-13'])('agrees on %s', async (stayDate) => {
    const rooms = await tx.trx('rooms').where({ room_type_id: typeId });
    const periods = await tx.trx('out_of_order_periods').whereIn('room_id', rooms.map((room) => room.id));
    const periodsByRoom = (roomId) => periods.filter((period) => String(period.room_id) === String(roomId));

    const fromSql = await livePhysicalCount({ db: accessor, roomTypeId: typeId, stayDate });
    const fromPredicate = rooms.filter((room) => roomCountsTowardCapacity(room, stayDate, periodsByRoom(room.id))).length;
    expect(fromPredicate).toBe(fromSql);
  });

  it('the out-of-order night really does differ, so the parity above is not vacuous', async () => {
    const during = await livePhysicalCount({ db: accessor, roomTypeId: typeId, stayDate: '2027-03-11' });
    const outside = await livePhysicalCount({ db: accessor, roomTypeId: typeId, stayDate: '2027-03-20' });
    expect(outside - during).toBe(1);
  });

  it('a room with a truthy has_discrepancy stored as 1 (MySQL boolean) is excluded', () => {
    expect(roomCountsTowardCapacity({ status: 'active', has_discrepancy: 1 }, '2027-01-01')).toBe(false);
    expect(roomCountsTowardCapacity({ status: 'active', has_discrepancy: 0 }, '2027-01-01')).toBe(true);
  });
});
