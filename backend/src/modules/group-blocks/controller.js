'use strict';

/**
 * HTTP layer for Group Blocks — parses the request, calls the service,
 * shapes the API.md §2 envelope. No business logic here; see `service.js`.
 *
 * Block CRUD and room-allocation writes are plain (not idempotency-wrapped)
 * — matching `reservations/controller.js`'s `configureOverbookingThreshold`
 * shape, `req.audit(...)` called directly after the write. Only
 * `billToSponsor` goes through `runIdempotentMutation` — see `service.js`'s
 * own header for why.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
const { expandStayDates } = require('../reservations/service');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Block CRUD
// ---------------------------------------------------------------------

async function createGroupBlock(req, res, next) {
  try {
    const blockName = require_(req.body, 'block_name');
    const startDate = require_(req.body, 'start_date');
    const endDate = require_(req.body, 'end_date');
    const block = await service.createGroupBlock({
      context: req.context,
      blockName,
      companyProfileId: req.body?.company_profile_id ?? null,
      startDate,
      endDate,
      cutoffDate: req.body?.cutoff_date,
      notes: req.body?.notes,
    });
    await req.audit({ entityType: 'group_blocks', entityId: block.id, action: 'create', afterState: block });
    res.status(201).json(ok(block));
  } catch (error) {
    next(error);
  }
}

async function updateGroupBlock(req, res, next) {
  try {
    const before = await service.getGroupBlock({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const block = await service.updateGroupBlock({
      context: req.context,
      id: req.params.id,
      changes: service.pickGroupBlockChanges(req.body),
    });
    await req.audit({ entityType: 'group_blocks', entityId: block.id, action: 'update', beforeState: before, afterState: block });
    res.status(200).json(ok(block));
  } catch (error) {
    next(error);
  }
}

async function getGroupBlock(req, res, next) {
  try {
    const block = await service.getGroupBlock({ context: req.context, id: req.params.id });
    if (!block) return notFound(res);
    res.status(200).json(ok(block));
  } catch (error) {
    next(error);
  }
}

async function listGroupBlocks(req, res, next) {
  try {
    res.status(200).json(ok(await service.listGroupBlocks({ context: req.context, status: req.query?.status })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Room allocations
// ---------------------------------------------------------------------

async function upsertGroupBlockRoomAllocation(req, res, next) {
  try {
    const roomTypeId = require_(req.body, 'room_type_id');
    const roomsBlocked = require_(req.body, 'rooms_blocked');
    const stayDate = req.body?.stay_date;
    const startDate = req.body?.start_date;
    const endDate = req.body?.end_date;
    let stayDates;
    if (stayDate) {
      // A single night — never routed through expandStayDates's
      // arrival-inclusive/departure-exclusive semantics, which would treat
      // an identical start/end as a zero-length stay and produce nothing.
      stayDates = [stayDate];
    } else if (startDate && endDate) {
      stayDates = expandStayDates(startDate, endDate);
    } else {
      throw new ValidationError('MISSING_FIELD', 'Either "stay_date" or both "start_date" and "end_date" are required.', [
        { field: 'stay_date', issue: 'missing' },
      ]);
    }
    const rows = await service.upsertGroupBlockRoomAllocation({
      context: req.context,
      groupBlockId: req.params.id,
      roomTypeId,
      stayDates,
      roomsBlocked: Number(roomsBlocked),
    });
    // A summary, not the raw row array — matching the established bulk-write
    // convention (`setup/controller.js`'s `bulkCreateRooms`) rather than
    // passing an array directly as `afterState` (a JSON column value knex/
    // mysql2 does not serialize the way a plain object does).
    await req.audit({
      entityType: 'group_block_rooms',
      entityId: req.params.id,
      action: 'upsert_allocation',
      afterState: { count: rows.length, room_type_id: roomTypeId, stay_dates: stayDates, rooms_blocked: Number(roomsBlocked) },
    });
    res.status(200).json(ok(rows));
  } catch (error) {
    next(error);
  }
}

async function listGroupBlockRoomAllocations(req, res, next) {
  try {
    res.status(200).json(ok(await service.listGroupBlockRoomAllocations({ context: req.context, groupBlockId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------

async function getBlockPickupSummary(req, res, next) {
  try {
    const summary = await service.getBlockPickupSummary({ context: req.context, groupBlockId: req.params.id });
    if (!summary) return notFound(res);
    res.status(200).json(ok(summary));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Group billing
// ---------------------------------------------------------------------

async function billToSponsor(req, res, next) {
  try {
    const before = await service.getGroupBlock({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    await runIdempotentMutation(req, res, {
      operationType: 'group_blocks.bill_to_sponsor',
      entityType: 'group_blocks',
      entityId: req.params.id,
      action: 'bill_to_sponsor',
      handler: async (trx) => {
        const result = await service.billBlockReservationsToSponsor({ trx, groupBlockId: req.params.id });
        return { status: 200, body: ok(result) };
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createGroupBlock,
  updateGroupBlock,
  getGroupBlock,
  listGroupBlocks,
  upsertGroupBlockRoomAllocation,
  listGroupBlockRoomAllocations,
  getBlockPickupSummary,
  billToSponsor,
};
