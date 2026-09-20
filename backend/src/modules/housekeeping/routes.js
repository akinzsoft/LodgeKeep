'use strict';

/**
 * Route wiring for the housekeeping module — PLAN.md Phase 3. Mounted under
 * `/api/v1` in `src/app.js`, after `authenticate('staff')` and
 * `attachAudit()` are already applied router-wide, same as every other
 * business module.
 *
 * SECURITY.md §5's matrix row for Housekeeping (revised, gap closure —
 * user-reported): `housekeeping` gets `Limited` (`.view` + `.operate` —
 * report a room's status, progress their OWN assignment); `manager`/
 * `admin`/`super_admin` get full access (`.view` + `.operate` + `.manage`
 * — assign/reassign, resolve discrepancies, out-of-order); `front_desk`
 * gets Read only; `cashier`/`pos_operator` get neither key.
 *
 * `updateAssignment` and `reportRoomStatus` are gated on `.operate` here,
 * the BROADER-reaching of the two mixed actions' keys — the narrower
 * ownership/reassignment checks (is this really your own assignment; are
 * you allowed to hand it to someone else) live in the controller, since a
 * route-level permission key alone can't express "only your own row." See
 * `controller.js`'s own header for that split.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function housekeepingRouter() {
  const router = Router();

  router.get('/housekeeping/board', requirePermission('housekeeping.view'), controller.listBoard);
  // Gap closure (user-reported): every user holding the housekeeping role
  // at this property — see controller.listAttendants's own header.
  router.get('/housekeeping/attendants', requirePermission('housekeeping.view'), controller.listAttendants);
  // Gap closure (user-reported): every active room, `housekeeping.view`-gated
  // rather than the `setup.view`-gated `GET /rooms` — see controller.listRooms.
  router.get('/housekeeping/rooms', requirePermission('housekeeping.view'), controller.listRooms);
  router.post('/housekeeping/assignments', requirePermission('housekeeping.manage'), controller.createAssignment);
  // Gap closure: .operate at the route level — controller.updateAssignment
  // itself requires .manage for a reassignment and ownership for a
  // status-only change.
  router.patch('/housekeeping/assignments/:id', requirePermission('housekeeping.operate'), controller.updateAssignment);

  // Gap closure: .operate — controller.reportRoomStatus itself requires
  // either .manage or a real assignment naming the caller as attendant.
  router.post('/housekeeping/rooms/:roomId/status', requirePermission('housekeeping.operate'), controller.reportRoomStatus);

  router.get('/housekeeping/discrepancies', requirePermission('housekeeping.view'), controller.listDiscrepancies);
  router.post('/housekeeping/discrepancies/:id/resolve', requirePermission('housekeeping.manage'), controller.resolveDiscrepancy);

  router.get('/housekeeping/out-of-order', requirePermission('housekeeping.view'), controller.listOutOfOrderPeriods);
  router.post('/housekeeping/out-of-order', requirePermission('housekeeping.manage'), controller.createOutOfOrderPeriod);
  router.patch('/housekeeping/out-of-order/:id', requirePermission('housekeeping.manage'), controller.closeOutOfOrderPeriod);

  return router;
}

module.exports = { housekeepingRouter };
