'use strict';

/**
 * HTTP layer for the housekeeping module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { scopedDb } = require('../../db');
const { hasPermission } = require('../../auth/rbac');
const { PermissionDeniedError } = require('../../auth/errors');
const { AssignmentNotYoursError, RoomNotAssignedToYouError } = require('./errors');
const service = require('./service');

/**
 * Gap closure: `housekeeping.manage` (assignment create/reassign,
 * discrepancy resolve, out-of-order) is checked at the route level
 * (`routes.js`) wherever the whole action is supervisor-only. Two actions
 * — `updateAssignment`'s status path and `reportRoomStatus` — are mixed:
 * a `housekeeping.operate`-only caller may use them, but only on their OWN
 * assignment; a `housekeeping.manage` holder may use them on anyone's. This
 * one shared lookup answers "does this caller hold the broader key," the
 * same `hasPermission` primitive `cashiering/controller.js`'s
 * `assertCanOverrideCreditLimit` already established for a field-
 * conditional secondary permission check.
 */
async function callerCanManageAny(req) {
  const db = scopedDb().for(req.context);
  return hasPermission(db, req.role, 'housekeeping.manage');
}

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

    const attendantUserId = req.body?.attendant_user_id;
    const status = req.body?.status;
    const canManageAny = await callerCanManageAny(req);

    // Gap closure: reassigning to a different attendant is a
    // housekeeping.manage action, regardless of whose assignment it is.
    if (attendantUserId && !canManageAny) {
      throw new PermissionDeniedError('housekeeping.manage', req.role);
    }
    // Gap closure: a housekeeping.operate-only caller may progress an
    // assignment's own status, but only when it's actually theirs.
    if (status && !canManageAny && String(before.attendant_user_id) !== String(req.context.userId)) {
      throw new AssignmentNotYoursError(id);
    }

    const assignment = await service.updateAssignment({ context: req.context, id, attendantUserId, status });
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

/**
 * Gap closure (user-reported): "all houseppers shld show" — see
 * `service.listAttendants`'s own header for why this is a dedicated,
 * `housekeeping.view`-gated read rather than reusing `GET /users`.
 */
async function listAttendants(req, res, next) {
  try {
    res.status(200).json(ok(await service.listAttendants({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

/**
 * Gap closure (user-reported): "the room number to select is emfpty" — see
 * `service.listRooms`'s own header for why this is a dedicated,
 * `housekeeping.view`-gated read rather than reusing `GET /rooms`.
 */
async function listRooms(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRooms({ context: req.context })));
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

    // Gap closure: a housekeeping.operate-only caller may report a room's
    // status only when a real assignment for it, today, names them as the
    // attendant — a housekeeping.manage holder's own spot-check needs none.
    if (!(await callerCanManageAny(req))) {
      const hasOwnAssignment = await service.hasOwnAssignmentForRoomToday({
        context: req.context,
        roomId,
        userId: req.context.userId,
      });
      if (!hasOwnAssignment) throw new RoomNotAssignedToYouError(roomId);
    }

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
  listAttendants,
  listRooms,
  reportRoomStatus,
  listDiscrepancies,
  resolveDiscrepancy,
  createOutOfOrderPeriod,
  listOutOfOrderPeriods,
  closeOutOfOrderPeriod,
};
