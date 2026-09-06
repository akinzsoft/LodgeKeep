'use strict';

/**
 * HTTP layer for the guest booking portal — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 *
 * Booking creation uses `withIdempotency` directly, not the shared
 * `runIdempotentMutation` wrapper every staff controller uses — this
 * follows exactly the two-phase local-then-external-call split
 * `cashiering/controller.js`'s own `capturePaystackPayment` already
 * established (ARCHITECTURE.md §6.4: an external HTTP call must never sit
 * inside the transaction that commits the local state), and needs the
 * second phase's own try/catch for the honest-202-partial-success case
 * `runIdempotentMutation` has no room for.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');
const { ValidationError } = require('../../shared/errors');
const { withIdempotency } = require('../../shared/idempotency');
const { requireIdempotencyKey } = require('../../shared/mutation');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function getPropertyBranding(req, res, next) {
  try {
    const branding = await service.getPropertyBranding({ context: req.context });
    if (!branding) return notFound(res);
    res.status(200).json(ok(branding));
  } catch (error) {
    next(error);
  }
}

async function listRoomTypes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRoomTypes({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listRateCodes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRateCodes({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

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

async function bookingResponseBody(created) {
  return { reservation: created.reservation, folio: created.folio, payment: created.payment };
}

/** POST /api/v1/portal/bookings — anonymous, guest-checkout-without-account (PRODUCT_REQUIREMENTS.md §3.16). */
async function createAnonymousBooking(req, res, next) {
  try {
    const roomTypeId = require_(req.body, 'room_type_id');
    const rateCodeId = require_(req.body, 'rate_code_id');
    const arrivalDate = require_(req.body, 'arrival_date');
    const departureDate = require_(req.body, 'departure_date');
    const email = require_(req.body, 'email');
    const firstName = require_(req.body, 'first_name');
    const lastName = require_(req.body, 'last_name');
    const key = requireIdempotencyKey(req);

    const outcome = await withIdempotency({
      context: req.context,
      operationType: 'portal.create_booking',
      key,
      payload: req.body,
      handler: async (trx) => {
        const guestId = await service.createAnonymousGuest({ trx, firstName, lastName, email, phone: req.body?.phone });
        const created = await service.createBookingWithPayment({
          trx,
          guestId,
          roomTypeId,
          rateCodeId,
          arrivalDate,
          departureDate,
          adults: req.body?.adults,
          children: req.body?.children,
          idempotencyKey: key,
        });
        return { status: 201, body: ok(await bookingResponseBody(created)) };
      },
    });

    await respondWithCheckout(req, res, outcome, email);
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/account/bookings — authenticated, the caller's own linked guest identity. */
async function createAccountBooking(req, res, next) {
  try {
    const roomTypeId = require_(req.body, 'room_type_id');
    const rateCodeId = require_(req.body, 'rate_code_id');
    const arrivalDate = require_(req.body, 'arrival_date');
    const departureDate = require_(req.body, 'departure_date');
    const key = requireIdempotencyKey(req);

    const own = await service.getOwnGuestAccount({ context: req.context });
    if (!own) return notFound(res);

    const outcome = await withIdempotency({
      context: req.context,
      operationType: 'portal.create_booking',
      key,
      payload: req.body,
      handler: async (trx) => {
        const created = await service.createBookingWithPayment({
          trx,
          guestId: own.guestId,
          roomTypeId,
          rateCodeId,
          arrivalDate,
          departureDate,
          adults: req.body?.adults,
          children: req.body?.children,
          idempotencyKey: key,
        });
        return { status: 201, body: ok(await bookingResponseBody(created)) };
      },
    });

    await respondWithCheckout(req, res, outcome, own.email);
  } catch (error) {
    next(error);
  }
}

/**
 * Shared tail of both booking-creation handlers — audits the local
 * creation (if not a replay), then attempts to start the real Paystack
 * checkout, exactly mirroring `cashiering/controller.js`'s own
 * `capturePaystackPayment`: a checkout failure still returns 202 with the
 * real, already-committed local state and a retry path, never a bare 500.
 */
async function respondWithCheckout(req, res, outcome, guestEmail) {
  const created = outcome.body.data;
  if (!outcome.replayed) {
    await req.audit({
      entityType: 'reservations',
      entityId: created.reservation.id,
      action: 'portal_create_booking',
      afterState: created.reservation,
    });
  }

  try {
    // The confirmation number doesn't exist until the reservation above was
    // created, so the client can only ever hand this a BASE url (its own
    // origin + confirmation route prefix) — the exact page Paystack must
    // redirect back to is built here, server-side, from the reservation
    // this same request just created, never trusted verbatim from the client.
    const callbackBase = req.body?.callback_base_url;
    const callbackUrl = callbackBase ? `${callbackBase}/${created.reservation.confirmation_number}` : undefined;
    const { payment, authorizationUrl } = await service.startCheckout({
      context: req.context,
      paymentId: created.payment.id,
      guestEmail,
      callbackUrl,
    });
    res.status(201).json(ok({ ...created, payment }, { authorizationUrl }));
  } catch (checkoutError) {
    res.status(202).json(
      ok(created, {
        checkoutError: checkoutError.message,
        retry: `/portal/bookings/${created.reservation.confirmation_number}/start-checkout`,
      })
    );
  }
}

/** GET /api/v1/portal/bookings/:confirmationNumber — public, session-independent. */
async function getBookingByConfirmation(req, res, next) {
  try {
    const reservation = await service.findBookingByConfirmationNumber({
      context: req.context,
      confirmationNumber: req.params.confirmationNumber,
    });
    if (!reservation) return notFound(res);
    res.status(200).json(ok(reservation));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/bookings/:confirmationNumber/start-checkout — retries a checkout call that failed to reach Paystack the first time. */
async function retryStartCheckout(req, res, next) {
  try {
    const reservation = await service.findBookingByConfirmationNumber({
      context: req.context,
      confirmationNumber: req.params.confirmationNumber,
    });
    if (!reservation) return notFound(res);
    const payment = await service.getLatestPaymentForReservation({ context: req.context, reservationId: reservation.id });
    if (!payment) return notFound(res);

    const email = require_(req.body, 'email');
    const { payment: updated, authorizationUrl } = await service.startCheckout({
      context: req.context,
      paymentId: payment.id,
      guestEmail: email,
      callbackUrl: req.body?.callback_url,
    });
    res.status(200).json(ok(updated, { authorizationUrl }));
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/portal/bookings/:confirmationNumber/confirm — the guest's browser returning from Paystack. */
async function confirmBookingPayment(req, res, next) {
  try {
    const reservation = await service.findBookingByConfirmationNumber({
      context: req.context,
      confirmationNumber: req.params.confirmationNumber,
    });
    if (!reservation) return notFound(res);
    const payment = await service.getLatestPaymentForReservation({ context: req.context, reservationId: reservation.id });
    if (!payment) return notFound(res);

    const result = await service.confirmBookingPayment({ context: req.context, reservationId: reservation.id, paymentId: payment.id });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** GET /api/v1/portal/account/bookings — authenticated. */
async function listMyBookings(req, res, next) {
  try {
    res.status(200).json(ok(await service.listMyBookings({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

/** GET /api/v1/portal/account/bookings/:id — authenticated, ownership-checked. */
async function getMyBooking(req, res, next) {
  try {
    const reservation = await service.getMyBooking({ context: req.context, id: req.params.id });
    if (!reservation) return notFound(res);
    res.status(200).json(ok(reservation));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPropertyBranding,
  listRoomTypes,
  listRateCodes,
  checkAvailability,
  createAnonymousBooking,
  createAccountBooking,
  getBookingByConfirmation,
  retryStartCheckout,
  confirmBookingPayment,
  listMyBookings,
  getMyBooking,
};
