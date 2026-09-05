'use strict';

/**
 * HTTP layer for the housekeeping module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function parseBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

// ---------------------------------------------------------------------
// Attendant assignments & the status board
// ---------------------------------------------------------------------

async function createAssignment(req, res, next) {
  try {
    const roomId = require_(req.body, 'room_id');
    const attendantUserId = require_(req.body, 'attendant_user_id');
    const businessDate = require_(req.body, 'business_date');
    const assignment = await service.createAssignment({ context: req.context, roomId, attendantUserId, businessDate });
    await req.audit({ entityType: 'housekeeping_assignments', entityId: assignment.id, action: 'create', afterState: assignment });
    res.status(201).json(ok(assignment));
  } catch (error) {
    next(error);
  }
}

async function updateAssignment(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getAssignment({ context: req.context, id });
    if (!before) return notFound(res);
    const assignment = await service.updateAssignment({
      context: req.context,
      id,
      attendantUserId: req.body?.attendant_user_id,
      status: req.body?.status,
    });
    await req.audit({ entityType: 'housekeeping_assignments', entityId: id, action: 'update', beforeState: before, afterState: assignment });
    res.status(200).json(ok(assignment));
  } catch (error) {
    next(error);
  }
}

async function listBoard(req, res, next) {
  try {
    const board = await service.listBoard({ context: req.context, businessDate: req.query?.business_date });
    res.status(200).json(ok(board));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Status reports & discrepancies
// ---------------------------------------------------------------------

async function reportRoomStatus(req, res, next) {
  try {
    const { roomId } = req.params;
    const cleanliness = require_(req.body, 'cleanliness');
    const occupancyObserved = require_(req.body, 'occupancy_observed');
    const result = await service.reportRoomStatus({
      context: req.context,
      roomId,
      cleanliness,
      occupancyObserved,
      userId: req.context.userId,
    });
    await req.audit({ entityType: 'rooms', entityId: roomId, action: 'report_status', afterState: result.room });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function listDiscrepancies(req, res, next) {
  try {
    const discrepancies = await service.listDiscrepancies({ context: req.context, resolved: parseBoolean(req.query?.resolved) });
    res.status(200).json(ok(discrepancies));
  } catch (error) {
    next(error);
  }
}

async function resolveDiscrepancy(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getDiscrepancy({ context: req.context, id });
    if (!before) return notFound(res);
    const discrepancy = await service.resolveDiscrepancy({
      context: req.context,
      id,
      userId: req.context.userId,
      resolutionNote: req.body?.resolution_note,
    });
    await req.audit({
      entityType: 'housekeeping_discrepancies',
      entityId: id,
      action: 'resolve',
      beforeState: before,
      afterState: discrepancy,
      reason: req.body?.resolution_note,
    });
    res.status(200).json(ok(discrepancy));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Out-of-order / out-of-service periods
// ---------------------------------------------------------------------

async function createOutOfOrderPeriod(req, res, next) {
  try {
    const roomId = require_(req.body, 'room_id');
    const type = require_(req.body, 'type');
    const reason = require_(req.body, 'reason');
    const startDate = require_(req.body, 'start_date');
    const endDate = require_(req.body, 'end_date');
    const period = await service.createOutOfOrderPeriod({
      context: req.context,
      roomId,
      type,
      reason,
      startDate,
      endDate,
      userId: req.context.userId,
    });
    await req.audit({ entityType: 'out_of_order_periods', entityId: period.id, action: 'create', afterState: period });
    res.status(201).json(ok(period));
  } catch (error) {
    next(error);
  }
}

async function listOutOfOrderPeriods(req, res, next) {
  try {
    const periods = await service.listOutOfOrderPeriods({ context: req.context, activeDate: req.query?.active_date });
    res.status(200).json(ok(periods));
  } catch (error) {
    next(error);
  }
}

async function closeOutOfOrderPeriod(req, res, next) {
  try {
    const { id } = req.params;
    const endDate = require_(req.body, 'end_date');
    const before = await service.getOutOfOrderPeriod({ context: req.context, id });
    if (!before) return notFound(res);
    const period = await service.closeOutOfOrderPeriod({ context: req.context, id, endDate });
    await req.audit({ entityType: 'out_of_order_periods', entityId: id, action: 'close', beforeState: before, afterState: period });
    res.status(200).json(ok(period));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createAssignment,
  updateAssignment,
  listBoard,
  reportRoomStatus,
  listDiscrepancies,
  resolveDiscrepancy,
  createOutOfOrderPeriod,
  listOutOfOrderPeriods,
  closeOutOfOrderPeriod,
};
