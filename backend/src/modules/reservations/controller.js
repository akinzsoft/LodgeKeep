'use strict';

/**
 * HTTP layer for the reservations + front desk module — parses the
 * request, calls the service, shapes the API.md §2 envelope. No business
 * logic here; see `service.js`.
 *
 * Every mutation goes through `withIdempotency` (`src/shared/idempotency.js`)
 * — ARCHITECTURE.md §11: "every transition endpoint accepts an idempotency
 * key". A missing `Idempotency-Key` header on one of these routes is a
 * `400 VALIDATION_MISSING_IDEMPOTENCY_KEY`, not a silently-processed request.
 *
 * Existence is checked BEFORE opening the idempotency transaction (the same
 * `before` fetch-and-check-null Phase 1's setup controllers use) rather than
 * inside the handler: a genuinely nonexistent or cross-tenant id is a plain
 * 404 with nothing recorded against the idempotency key at all. A state
 * that changed between that check and the transaction is instead caught by
 * `isValidTransition` inside the service call itself, correctly reported as
 * `422 BUSINESS_RULE_INVALID_RESERVATION_TRANSITION` rather than a 404 —
 * the row does exist, it just moved.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { withIdempotency } = require('../../shared/idempotency');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function requireIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new ValidationError('MISSING_IDEMPOTENCY_KEY', 'The "Idempotency-Key" header is required for this action.');
  }
  return key;
}

/** Runs a mutation through `withIdempotency`, audits it only on a real (non-replayed) execution, and writes the response. */
async function runMutation(req, res, { operationType, entityType, entityId, action, handler }) {
  const key = requireIdempotencyKey(req);
  const result = await withIdempotency({
    context: req.context,
    operationType,
    key,
    payload: req.body,
    handler,
  });
  if (!result.replayed) {
    await req.audit({
      entityType,
      entityId: entityId ?? result.body?.data?.id ?? null,
      action,
      afterState: result.body?.data,
      reason: req.body?.reason,
    });
  }
  res.status(result.status).json(result.body);
}

// ---------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------

async function createGuest(req, res, next) {
  try {
    const firstName = require_(req.body, 'first_name');
    const lastName = require_(req.body, 'last_name');
    const guest = await service.createGuest({
      context: req.context,
      firstName,
      lastName,
      email: req.body?.email,
      phone: req.body?.phone,
    });
    await req.audit({ entityType: 'guests', entityId: guest.id, action: 'create', afterState: guest });
    res.status(201).json(ok(guest));
  } catch (error) {
    next(error);
  }
}

async function listGuests(req, res, next) {
  try {
    res.status(200).json(ok(await service.listGuests({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

async function checkAvailability(req, res, next) {
  try {
    const roomTypeId = require_(req.query, 'room_type_id');
    const arrivalDate = require_(req.query, 'arrival_date');
    const departureDate = require_(req.query, 'departure_date');
    const result = await service.checkAvailability({ context: req.context, roomTypeId, arrivalDate, departureDate });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------

async function createReservation(req, res, next) {
  try {
    const guestId = require_(req.body, 'guest_id');
    const roomTypeId = require_(req.body, 'room_type_id');
    const rateCodeId = require_(req.body, 'rate_code_id');
    const arrivalDate = require_(req.body, 'arrival_date');
    const departureDate = require_(req.body, 'departure_date');

    await runMutation(req, res, {
      operationType: 'reservations.create',
      entityType: 'reservations',
      action: 'create',
      handler: async (trx) => {
        const reservation = await service.createReservation({
          trx,
          guestId,
          roomTypeId,
          rateCodeId,
          arrivalDate,
          departureDate,
          adults: req.body?.adults,
          children: req.body?.children,
          asHold: req.body?.as_hold === true,
          allowWaitlist: req.body?.allow_waitlist === true,
        });
        return { status: 201, body: ok(reservation) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getReservation(req, res, next) {
  try {
    const reservation = await service.getReservation({ context: req.context, id: req.params.id });
    if (!reservation) return notFound(res);
    res.status(200).json(ok(reservation));
  } catch (error) {
    next(error);
  }
}

async function listReservations(req, res, next) {
  try {
    const reservations = await service.listReservations({
      context: req.context,
      status: req.query?.status,
      arrivalDateFrom: req.query?.arrival_date_from,
      arrivalDateTo: req.query?.arrival_date_to,
      roomTypeId: req.query?.room_type_id,
    });
    res.status(200).json(ok(reservations));
  } catch (error) {
    next(error);
  }
}

async function listWaitlist(req, res, next) {
  try {
    res.status(200).json(ok(await service.listWaitlist({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

function transitionAction(operationSuffix, serviceFn) {
  return async function action(req, res, next) {
    try {
      const { id } = req.params;
      const before = await service.getReservation({ context: req.context, id });
      if (!before) return notFound(res);

      await runMutation(req, res, {
        operationType: `reservations.${operationSuffix}`,
        entityType: 'reservations',
        entityId: id,
        action: operationSuffix,
        handler: async (trx) => {
          const reservation = await serviceFn({ trx, req });
          return { status: 200, body: ok(reservation) };
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

const confirmReservation = transitionAction('confirm', ({ trx, req }) => service.confirmReservation({ trx, id: req.params.id }));
const promoteWaitlist = transitionAction('promote_waitlist', ({ trx, req }) =>
  service.promoteWaitlist({ trx, id: req.params.id })
);
const cancelReservation = transitionAction('cancel', ({ trx, req }) =>
  service.cancelReservation({ trx, id: req.params.id, reason: req.body?.reason })
);
const markNoShow = transitionAction('mark_no_show', ({ trx, req }) => service.markNoShow({ trx, id: req.params.id }));

async function addNote(req, res, next) {
  try {
    const note = require_(req.body, 'note');
    const { id } = req.params;
    const reservation = await service.getReservation({ context: req.context, id });
    if (!reservation) return notFound(res);
    const created = await service.addNote({ context: req.context, reservationId: id, userId: req.context.userId, note });
    await req.audit({ entityType: 'reservation_notes', entityId: created.id, action: 'create', afterState: created });
    res.status(201).json(ok(created));
  } catch (error) {
    next(error);
  }
}

async function listNotes(req, res, next) {
  try {
    const { id } = req.params;
    const reservation = await service.getReservation({ context: req.context, id });
    if (!reservation) return notFound(res);
    res.status(200).json(ok(await service.listNotes({ context: req.context, reservationId: id })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Front desk
// ---------------------------------------------------------------------

async function listArrivals(req, res, next) {
  try {
    res.status(200).json(ok(await service.listArrivals({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listDepartures(req, res, next) {
  try {
    res.status(200).json(ok(await service.listDepartures({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listInHouse(req, res, next) {
  try {
    res.status(200).json(ok(await service.listInHouse({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function checkIn(req, res, next) {
  try {
    const { id } = req.params;
    const roomId = require_(req.body, 'room_id');
    const before = await service.getReservation({ context: req.context, id });
    if (!before) return notFound(res);

    await runMutation(req, res, {
      operationType: 'reservations.check_in',
      entityType: 'reservations',
      entityId: id,
      action: 'check_in',
      handler: async (trx) => {
        const reservation = await service.checkIn({ trx, id, roomId, overrideDirty: req.body?.override_dirty === true });
        return { status: 200, body: ok(reservation) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function checkOut(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getReservation({ context: req.context, id });
    if (!before) return notFound(res);

    await runMutation(req, res, {
      operationType: 'reservations.check_out',
      entityType: 'reservations',
      entityId: id,
      action: 'check_out',
      handler: async (trx) => {
        const result = await service.checkOut({
          trx,
          id,
          scheduledCheckoutTime: req.body?.scheduled_checkout_time,
          actualCheckoutTime: req.body?.actual_checkout_time,
          earlyCutoffTime: req.body?.early_cutoff_time,
          earlyDepartureFee: req.body?.early_departure_fee,
          lateCheckoutFee: req.body?.late_checkout_fee,
        });
        return { status: 200, body: ok(result.reservation, { fee: result.fee }) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function roomMove(req, res, next) {
  try {
    const { id } = req.params;
    const newRoomId = require_(req.body, 'new_room_id');
    const reason = require_(req.body, 'reason');
    const before = await service.getReservation({ context: req.context, id });
    if (!before) return notFound(res);

    await runMutation(req, res, {
      operationType: 'reservations.room_move',
      entityType: 'reservations',
      entityId: id,
      action: 'room_move',
      handler: async (trx) => {
        const assignment = await service.roomMove({ trx, id, newRoomId, reason });
        return { status: 200, body: ok(assignment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createGuest,
  listGuests,
  checkAvailability,
  createReservation,
  getReservation,
  listReservations,
  listWaitlist,
  confirmReservation,
  promoteWaitlist,
  cancelReservation,
  markNoShow,
  addNote,
  listNotes,
  listArrivals,
  listDepartures,
  listInHouse,
  checkIn,
  checkOut,
  roomMove,
};
