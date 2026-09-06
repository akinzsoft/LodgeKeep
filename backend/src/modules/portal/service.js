'use strict';

/**
 * PLAN.md Phase 4 — the guest booking portal (PRODUCT_REQUIREMENTS.md
 * §3.14/§3.16). Thin orchestration over `reservations/service.js` and
 * `cashiering/service.js` — the same cross-module service-to-service call
 * pattern those two already use with each other (`reservations/service.js`
 * already imports directly from `cashiering/service.js` for folio
 * adjustments; this module does the same for both).
 *
 * ── MONEY: A BOOKING IS PAID IN FULL, UP FRONT, PER NIGHT ────────────────
 *
 * A charge is posted for EVERY night of the stay individually, each dated
 * to its own `stay_date` — never one aggregate charge for the whole stay.
 * This is the only shape that doesn't collide with Night Audit's own
 * idempotency guard (`src/modules/night-audit/service.js`'s room-charge
 * step skips reposting only when a non-voided `room_charge` already exists
 * for a given `(folio_id, business_date)`): pre-posting a charge that
 * already carries the exact `business_date` Night Audit would have used
 * for each night means Night Audit correctly finds every night of the stay
 * already accounted for once the guest checks in, rather than double-
 * billing nights 2..N. No partial-deposit/percentage-due-at-property
 * configuration exists anywhere in this schema — full prepayment only, a
 * deliberate simplification, flagged rather than silently assumed.
 *
 * ── BOOKING STARTS AS A HOLD, NEVER A FIRM CONFIRMATION ──────────────────
 *
 * `createReservation` is always called with `asHold: true` here — a portal
 * booking is `tentative` until payment is verified `CAPTURED`, at which
 * point `confirmReservation` flips it to `confirmed` and — for free, since
 * that function already does this — fires the real `reservation.confirmed`
 * outbox event/email. `createReservation` only emits a confirmation email
 * when a reservation lands DIRECTLY on `confirmed`; calling it with
 * `asHold: false` here would email a guest "you're confirmed" before they
 * had paid anything, and a later payment failure would then need to
 * contradict that email immediately with a cancellation. Starting as a
 * hold avoids the contradiction entirely — zero new notification code
 * either way, since both `confirmReservation` and `cancelReservation`
 * already emit the right event.
 *
 * ── ORPHAN PREVENTION ─────────────────────────────────────────────────────
 *
 * `abandonUnpaidBooking` is the one piece of orchestration with no existing
 * precedent to reuse — it voids every posted room charge (whose own tax
 * lines void automatically via `voidLineItem`'s existing cascade — see
 * that function's own header) and closes the folio, then cancels the
 * reservation (which releases the held inventory and fires the existing
 * `reservation.cancelled` event/email). Triggered synchronously when the
 * guest's own browser returns from Paystack and calls the confirm
 * endpoint, which re-verifies against the real gateway first
 * (`cashiering.verifyPayment`) — covering the case the webhook hasn't
 * landed yet. A guest who abandons Paystack's page and never returns at
 * all is NOT actively reconciled by this pass — flagged, not hidden,
 * matching Night Audit's own accepted "no background heartbeat-sweeping
 * monitor process" reduction (that module's own header).
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const reservationsService = require('../reservations/service');
const cashieringService = require('../cashiering/service');
const setupService = require('../setup/service');

async function getPropertyBranding({ context }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first('name', 'logo_url', 'theme', 'base_currency');
  if (!property) return null;
  return { name: property.name, logoUrl: property.logo_url, theme: property.theme ?? null, baseCurrency: property.base_currency };
}

/**
 * A guest picking a room doesn't shop rate plans the way staff do — this
 * lists active room types for the search screen, and the frontend resolves
 * a booking's `rate_code_id` to whichever active rate code sorts first
 * (`listRateCodes` below), the closest honest stand-in for "the standard
 * rate" this codebase has: no packages/promotions/"best available rate"
 * concept exists anywhere yet (`cashiering`'s own module header already
 * flags packages as unbuilt).
 */
async function listRoomTypes({ context }) {
  return setupService.listRoomTypes({ context });
}

async function listRateCodes({ context }) {
  return setupService.listRateCodes({ context });
}

async function checkAvailability({ context, roomTypeId, arrivalDate, departureDate }) {
  return reservationsService.checkAvailability({ context, roomTypeId, arrivalDate, departureDate });
}

/** Every authenticated ownership check starts here — the account's own linked `guests` row and email, or null if the account carries no `guest_id` at all. */
async function getOwnGuestAccount({ context }) {
  const db = scopedDb().for(context);
  const account = await db.table('guest_accounts').where({ id: context.guestAccountId }).first('guest_id', 'email');
  if (!account?.guest_id) return null;
  return { guestId: account.guest_id, email: account.email };
}

async function listMyBookings({ context }) {
  const own = await getOwnGuestAccount({ context });
  if (!own) return [];
  const db = scopedDb().for(context);
  return db.table('reservations').where({ guest_id: own.guestId }).orderBy('arrival_date', 'desc');
}

async function getMyBooking({ context, id }) {
  const own = await getOwnGuestAccount({ context });
  if (!own) return null;
  const db = scopedDb().for(context);
  return db.table('reservations').where({ id, guest_id: own.guestId }).first();
}

/**
 * Public, session-independent lookup — `confirmation_number` is a ULID
 * (ARCHITECTURE.md §10: "safe to expose, reveals no sequence/volume"),
 * `UNIQUE(tenant_id, confirmation_number)` — so this is `acrossProperties()`,
 * the same reasoning `listProperties` (src/modules/setup/service.js) gives
 * for "which properties may I reach," applied to "which property is this
 * confirmation number even under."
 */
async function findBookingByConfirmationNumber({ context, confirmationNumber }) {
  const db = scopedDb().for(context);
  return db.acrossProperties().table('reservations').where({ confirmation_number: confirmationNumber }).first();
}

async function createAnonymousGuest({ trx, firstName, lastName, email, phone }) {
  const [guestId] = await trx.table('guests').insert({ first_name: firstName, last_name: lastName, email, phone: phone ?? null });
  return guestId;
}

/**
 * The booking+payment-intent creation itself — one transaction, called by
 * both the anonymous and account-linked controllers (the only difference
 * between them is where `guestId` comes from — a fresh row here, or the
 * caller's own already-linked `guests` row there).
 */
async function createBookingWithPayment({ trx, guestId, roomTypeId, rateCodeId, arrivalDate, departureDate, adults, children, idempotencyKey }) {
  const reservation = await reservationsService.createReservation({
    trx,
    guestId,
    roomTypeId,
    rateCodeId,
    arrivalDate,
    departureDate,
    adults,
    children,
    asHold: true,
    allowWaitlist: false,
  });

  await cashieringService.ensurePrimaryFolio({ trx, reservationId: reservation.id });
  const folio = await trx.table('folios').where({ reservation_id: reservation.id }).first();

  const dailyRates = await trx.table('reservation_daily_rates').where({ reservation_id: reservation.id });
  for (const dailyRate of dailyRates) {
    await cashieringService.postCharge({
      trx,
      folioId: folio.id,
      type: 'room_charge',
      description: `Room charge — ${dailyRate.stay_date}`,
      amount: dailyRate.rate,
      businessDate: dailyRate.stay_date,
      userId: null,
    });
  }

  const paidFolio = await trx.table('folios').where({ id: folio.id }).first();
  const payment = await cashieringService.initiatePaystackPaymentIntent({
    trx,
    folioId: folio.id,
    amount: paidFolio.balance,
    currency: paidFolio.currency,
    idempotencyKey,
  });

  return { reservation, folio: paidFolio, payment };
}

async function startCheckout({ context, paymentId, guestEmail, callbackUrl }) {
  return cashieringService.startPaystackCheckout({ context, paymentId, guestEmail, callbackUrl });
}

/** The one payment a portal booking ever creates (this module never opens a second payment intent against the same folio) — the most recent row is always the right one. */
async function getLatestPaymentForReservation({ context, reservationId }) {
  const db = scopedDb().for(context);
  const folio = await db.table('folios').where({ reservation_id: reservationId }).first();
  if (!folio) return null;
  return db.table('payments').where({ folio_id: folio.id }).orderBy('id', 'desc').first();
}

/**
 * Voids every posted room charge on the reservation's open folio (tax
 * lines cascade-void automatically — `voidLineItem`'s own mechanism) and
 * closes it, then cancels the reservation. Idempotent in the sense that
 * matters here: called only when the caller has already confirmed the
 * reservation is still `tentative` (see `confirmBookingPayment` below).
 */
async function abandonUnpaidBooking({ trx, reservationId, reason }) {
  const folio = await trx.table('folios').where({ reservation_id: reservationId, status: 'open' }).first();
  if (folio) {
    const chargeLines = await trx.table('folio_line_items').where({ folio_id: folio.id, type: 'room_charge' }).whereNull('voided_at');
    for (const line of chargeLines) {
      await cashieringService.voidLineItem({ trx, lineItemId: line.id, reason, userId: null });
    }
    await trx.table('folios').where({ id: folio.id }).update({ status: 'closed', closed_at: new Date() });
  }
  return reservationsService.cancelReservation({ trx, id: reservationId, reason });
}

/**
 * Called when the guest's browser returns from Paystack. Re-verifies
 * against the real gateway first (covers the case the webhook hasn't
 * landed yet), then either confirms the booking (payment `CAPTURED`) or
 * releases it (payment `FAILED`/`EXPIRED`) — but only while the
 * reservation is still `tentative`; one already moved past that (confirmed
 * by an earlier call, or already cancelled) is left untouched, which is
 * what makes a repeated call to this endpoint safe.
 */
async function confirmBookingPayment({ context, reservationId, paymentId }) {
  const payment = await cashieringService.verifyPayment({ context, paymentId, userId: null });

  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const reservation = await trx.table('reservations').where({ id: reservationId }).first();
    if (!reservation) throw new ValidationError('RESERVATION_NOT_FOUND', 'The specified reservation does not exist.');

    if (reservation.status !== 'tentative') {
      return { reservation, payment };
    }

    if (payment.status === 'CAPTURED') {
      return { reservation: await reservationsService.confirmReservation({ trx, id: reservationId }), payment };
    }

    if (payment.status === 'FAILED') {
      return { reservation: await abandonUnpaidBooking({ trx, reservationId, reason: 'Guest portal payment failed.' }), payment };
    }

    return { reservation, payment };
  });
}

module.exports = {
  getPropertyBranding,
  listRoomTypes,
  listRateCodes,
  checkAvailability,
  getOwnGuestAccount,
  listMyBookings,
  getMyBooking,
  findBookingByConfirmationNumber,
  createAnonymousGuest,
  createBookingWithPayment,
  startCheckout,
  getLatestPaymentForReservation,
  abandonUnpaidBooking,
  confirmBookingPayment,
};
