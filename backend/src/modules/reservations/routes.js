'use strict';

/**
 * Route wiring for the reservations + front desk module — PLAN.md Phase 2.
 * Mounted under `/api/v1` in `src/app.js`, after `authenticate('staff')`
 * and `attachAudit()` are already applied router-wide, same as
 * `src/modules/setup`.
 *
 * ── ONE MODULE, TWO PERMISSION DOMAINS ──────────────────────────────────
 *
 * PRODUCT_REQUIREMENTS.md gives Reservations (§3.2) and Front Desk (§3.3)
 * separate sections, and SECURITY.md §5's RBAC matrix draws separate rows
 * for them with a real difference: `cashier` gets Read on Reservations but
 * nothing on Front Desk. That is why there are four permission keys
 * (`reservations.view`/`.manage`, `front_desk.view`/`.manage`), gated
 * per-route below according to which matrix row each action falls under.
 *
 * But the backend code is ONE module (`src/modules/reservations`), not
 * two: both sections operate on the same `reservations` row and the same
 * ARCHITECTURE.md §11 state machine — check-in/check-out/room-move ARE
 * reservation transitions, not a separate entity. Splitting the code into
 * two modules would mean either duplicating access to the `reservations`
 * table or one module reaching into the other's model layer, which
 * CLAUDE.md's module-boundary rule ("cross-module calls go through service
 * functions, never direct model access") argues against. One module, two
 * gates, is the smaller amount of real complexity.
 *
 * Static-path routes (`/reservations/waitlist`, `/front-desk/*`) are
 * declared before `/reservations/:id` so Express does not swallow
 * "waitlist" as an `:id` value.
 */

const { Router } = require('express');
const controller = require('./controller');
const { requirePermission } = require('../../auth');

function reservationsRouter() {
  const router = Router();

  // Guests — minimal stub CRUD in service of booking a reservation (see
  // the `guests` migration's own header for scope). Gated under the
  // reservations domain: there is no standalone Guest Profiles permission
  // in this pass.
  router.get('/guests', requirePermission('reservations.view'), controller.listGuests);
  router.post('/guests', requirePermission('reservations.manage'), controller.createGuest);

  router.get('/availability', requirePermission('reservations.view'), controller.checkAvailability);

  // PLAN.md Phase 3: the missing overbooking-threshold config endpoint —
  // static path components either side of the two path params, no
  // collision risk with `/reservations/:id`-style routes below.
  router.put(
    '/room-types/:roomTypeId/inventory/:stayDate',
    requirePermission('reservations.manage'),
    controller.configureOverbookingThreshold
  );

  router.get('/reservations/waitlist', requirePermission('reservations.view'), controller.listWaitlist);
  router.get('/reservations', requirePermission('reservations.view'), controller.listReservations);
  router.post('/reservations', requirePermission('reservations.manage'), controller.createReservation);
  router.get('/reservations/:id', requirePermission('reservations.view'), controller.getReservation);

  router.post('/reservations/:id/confirm', requirePermission('reservations.manage'), controller.confirmReservation);
  router.post('/reservations/:id/promote-waitlist', requirePermission('reservations.manage'), controller.promoteWaitlist);
  router.post('/reservations/:id/cancel', requirePermission('reservations.manage'), controller.cancelReservation);
  router.post('/reservations/:id/mark-no-show', requirePermission('reservations.manage'), controller.markNoShow);

  router.get('/reservations/:id/notes', requirePermission('reservations.view'), controller.listNotes);
  router.post('/reservations/:id/notes', requirePermission('reservations.manage'), controller.addNote);

  // Front desk boards and actions.
  router.get('/front-desk/arrivals', requirePermission('front_desk.view'), controller.listArrivals);
  router.get('/front-desk/departures', requirePermission('front_desk.view'), controller.listDepartures);
  router.get('/front-desk/in-house', requirePermission('front_desk.view'), controller.listInHouse);

  router.post('/reservations/:id/check-in', requirePermission('front_desk.manage'), controller.checkIn);
  router.post('/reservations/:id/check-out', requirePermission('front_desk.manage'), controller.checkOut);
  router.post('/reservations/:id/room-move', requirePermission('front_desk.manage'), controller.roomMove);

  return router;
}

module.exports = { reservationsRouter };
