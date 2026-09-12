'use strict';

/**
 * QR self-ordering service — PLAN.md Phase 6 (PRODUCT_REQUIREMENTS.md
 * §3.4's QR-ordering section, deferred from the already-shipped POS core
 * pass). Thin orchestration over `pos/service.js`/`cashiering/service.js`/
 * `reservations/service.js`, the same cross-module service-call pattern
 * `portal/service.js` already established for an anonymous, no-login
 * surface.
 *
 * ── ONE-WAY DEPENDENCIES ONLY ─────────────────────────────────────────────
 *
 * This module depends on `pos`, `cashiering`, `reservations`, and
 * `notifications` — none of those require this module back, so there is
 * no cycle. `cashiering/service.js` itself gained two small, pos-specific
 * functions this pass (`initiatePosOrderPaystackPaymentIntent`,
 * `finalizePosOrderCardCapture`) rather than reaching back into
 * `pos/service.js` for them, precisely to avoid creating one (see that
 * file's own header comment).
 *
 * ── PAYMENT FLOWS ─────────────────────────────────────────────────────────
 *
 * Card: `createGuestOrder` opens the tab (source: 'guest') and its items,
 * unpaid, `awaiting_payment`, its Paystack payment intent created in the
 * SAME transaction; `startGuestOrderCheckout` (called by the controller
 * right after, and again on a guest's own retry) then reuses the exact
 * same real Paystack machinery a folio payment already uses
 * (`initiatePosOrderPaystackPaymentIntent` + the UNCHANGED
 * `startPaystackCheckout`) — capture (webhook OR the guest's own
 * confirm-payment callback, both converging on `applyGatewayResult`) is
 * what actually posts the `pos_order_settlements` row and flips the order
 * to `received`/`paid` (`cashiering/service.js`'s `finalizePosOrderCardCapture`).
 *
 * Room charge: the second factor this session confirmed with the user —
 * a one-time code emailed to the room's CURRENT IN-HOUSE RESERVATION'S
 * OWN registered email, never a guest-typed contact
 * (`reservations/service.js`'s `findInHouseReservationForRoom`). Once
 * verified, `verifyRoomChargeOtpAndSettle` calls the EXISTING, UNCHANGED
 * `posService.settleOrder` with `settledByUserId: null` — the identical
 * function a staff-operated register already uses to post a room charge.
 *
 * ── AUTO-REJECT IS LAZY, NOT A JOB ────────────────────────────────────────
 *
 * `resolveEffectiveGuestOrderStatus` is called on every read of a guest
 * order (both the guest's own polling and staff's queue) — an order
 * `received` past its outlet's own configured accept-timeout, never
 * `accepted_at`, reads as `auto_rejected` the next time anyone looks,
 * mirroring this codebase's own "recovery evaluated lazily, no background
 * sweeping monitor" precedent (Night Audit's own header). The actual
 * status-claiming transition is a conditional UPDATE (ARCHITECTURE.md §5)
 * so two concurrent readers racing past the same timeout can only have one
 * of them actually perform the reversal.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { sumMoney, compareMoney } = require('../../shared/money');
const { computeItemLineTotal } = require('../../shared/pos-pricing');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../cashiering/tax-engine');
const { withIdempotency } = require('../../shared/idempotency');
const { writeOutboxEvent } = require('../../shared/outbox');
const { enqueueOutboxDispatch } = require('../../jobs/outbox-dispatcher');

const posService = require('../pos/service');
const { OutletNotFoundError, MenuItemNotFoundError, OrderNotOpenError } = require('../pos/errors');
const cashieringService = require('../cashiering/service');
const reservationsService = require('../reservations/service');

const { generateRawToken, hashToken, encryptToken, decryptToken, renderTokenQrImage } = require('./tokens');
const { generateOtpCode, hashOtpCode, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS } = require('./otp');
const {
  GuestOrderingDisabledError,
  UnpaidValueCapExceededError,
  GuestOrderNotFoundError,
  WrongPaymentMethodError,
  OrderAlreadyPaidError,
  OtpInvalidError,
  NoInHouseReservationError,
  EmptyCartError,
  GuestOrderStateConflictError,
  GuestOrderAlreadyRejectedError,
} = require('./errors');

/**
 * Code-review fix (CRITICAL) — every guest-facing action that can move
 * money (request a room-charge OTP, verify one, confirm a card payment)
 * must refuse outright once staff have already turned this order away,
 * checked against `pos_guest_orders.status` explicitly rather than
 * inferring it from `payment_status`/`pos_orders.status` alone (neither
 * of those tells "never paid" apart from "rejected and must stay that
 * way"). This is a fast, sequential-read check — the real, load-bearing
 * guarantee against a genuinely CONCURRENT reject is the row-level
 * locking `reverseGuestOrderPayment`/`posService.voidOrder`/
 * `posService.settleOrder` already do, below.
 */
function assertGuestOrderNotRejected(guestOrder) {
  if (guestOrder.status === 'rejected' || guestOrder.status === 'auto_rejected') {
    throw new GuestOrderAlreadyRejectedError(guestOrder.status);
  }
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

// ---------------------------------------------------------------------
// Guest-facing — menu, order creation, payment
// ---------------------------------------------------------------------

async function getMenuForToken({ context, token }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: token.outlet_id }).first();
  if (!outlet || !outlet.guest_ordering_enabled) throw new GuestOrderingDisabledError();
  const items = await db
    .table('pos_menu_items')
    .where({ outlet_id: token.outlet_id, status: 'active', is_available: true })
    .orderBy('category')
    .orderBy('name');
  return { outlet: { id: outlet.id, name: outlet.name, type: outlet.type }, items };
}

/**
 * The current total value of every still-open, not-yet-paid guest order
 * against this token — the number `createGuestOrder` compares a new
 * cart's value against for the outlet's own configured cap. A locking
 * read (`.forUpdate()`), not a plain SELECT: under REPEATABLE READ, a
 * plain read here would still see this transaction's own snapshot from
 * BEFORE the token row lock (below) was even requested, not what a
 * just-committed concurrent order actually added — the identical
 * "lock, then check with a locking read" gotcha `pos/service.js`'s own
 * `lockOrderAndItem` already documents for the exact same reason.
 */
async function sumOpenUnpaidValueForToken({ trx, tokenId }) {
  const rows = await trx
    .table('pos_guest_orders')
    .joinScoped('pos_order_items', (join) => join.on('pos_order_items.pos_order_id', '=', 'pos_guest_orders.pos_order_id'))
    .where({ 'pos_guest_orders.token_id': tokenId, 'pos_guest_orders.payment_status': 'unpaid' })
    .whereNotIn('pos_guest_orders.status', ['rejected', 'auto_rejected'])
    .whereNull('pos_order_items.voided_at')
    .forUpdate()
    .select('pos_order_items.unit_price', 'pos_order_items.quantity', 'pos_order_items.modifiers');
  return sumMoney(rows.map(computeItemLineTotal));
}

/**
 * Opens a real `pos_orders` tab (`source: 'guest'`) plus its items and the
 * guest-facing `pos_guest_orders` row, all inside one transaction
 * (`withIdempotency` — a real financial mutation, ARCHITECTURE.md §7,
 * retried on a flaky mobile connection must not double-order). The
 * `pos_order_tokens` row is locked FIRST, inside that same transaction —
 * the one natural "one thing per QR code" serialization point for the
 * unpaid-value cap check below, the same reasoning the entitlement-gating
 * pass already established for locking `tenants` before its own
 * count-then-insert race.
 */
async function createGuestOrder({ context, token, cart, paymentMethod, guestContact, guestName, idempotencyKey }) {
  if (!Array.isArray(cart) || cart.length === 0) throw new EmptyCartError();
  if (paymentMethod !== 'card' && paymentMethod !== 'room_charge') {
    throw new ValidationError('INVALID_PAYMENT_METHOD', '"payment_method" must be "card" or "room_charge".', [{ field: 'payment_method', issue: 'invalid' }]);
  }
  if (paymentMethod === 'room_charge' && token.type !== 'room') {
    throw new WrongPaymentMethodError('Charge-to-room is only available for a room QR code.');
  }
  if (paymentMethod === 'card' && (!guestContact || !guestContact.includes('@'))) {
    throw new ValidationError('MISSING_FIELD', 'A valid email is required to pay by card.', [{ field: 'guest_contact', issue: 'missing_or_invalid' }]);
  }

  return withIdempotency({
    context,
    operationType: 'qr_ordering.create_order',
    key: idempotencyKey,
    payload: { tokenId: token.id, cart, paymentMethod, guestContact, guestName },
    handler: async (trx) => {
      const lockedToken = await trx.table('pos_order_tokens').where({ id: token.id }).forUpdate().first();
      if (!lockedToken || !lockedToken.active) throw new GuestOrderingDisabledError();

      const outlet = await trx.table('pos_outlets').where({ id: lockedToken.outlet_id }).first();
      if (!outlet || !outlet.guest_ordering_enabled) throw new GuestOrderingDisabledError();

      const resolvedItems = [];
      let cartTotal = '0.00';
      for (const line of cart) {
        // Matched in the WHERE clause, not fetched-then-compared in JS —
        // `pos/service.js`'s own `openOrder`/`addItem` comment explains
        // why (a BIGINT id can round-trip as a string or a number).
        const menuItem = await trx.table('pos_menu_items').where({ id: line.menu_item_id, outlet_id: outlet.id }).first();
        if (!menuItem) throw new MenuItemNotFoundError();
        if (!menuItem.is_available) {
          throw new ValidationError('POS_ITEM_UNAVAILABLE', `"${menuItem.name}" is currently marked unavailable.`);
        }
        const quantity = line.quantity ?? 1;
        const lineTotal = computeItemLineTotal({ unit_price: menuItem.price, quantity, modifiers: line.modifiers });
        cartTotal = sumMoney([cartTotal, lineTotal]);
        resolvedItems.push({ menuItem, quantity, modifiers: line.modifiers ?? null });
      }

      // A pre-tax guarding value, not the final charged total (tax is
      // resolved at settle time, per `pos/service.js`'s own "tax at
      // settle-time" convention) — coarse on purpose, this cap exists to
      // bound runaway/abusive ordering against one token, not to predict
      // the exact amount a guest will eventually be charged.
      if (outlet.guest_order_max_unpaid_value != null) {
        const existing = await sumOpenUnpaidValueForToken({ trx, tokenId: lockedToken.id });
        const projected = sumMoney([existing, cartTotal]);
        if (compareMoney(projected, outlet.guest_order_max_unpaid_value) > 0) {
          throw new UnpaidValueCapExceededError(outlet.guest_order_max_unpaid_value);
        }
      }

      let tableLabel = null;
      if (lockedToken.type === 'table') {
        tableLabel = lockedToken.table_label;
      } else {
        const room = await trx.table('rooms').where({ id: lockedToken.room_id }).first('room_number');
        tableLabel = room ? `Room ${room.room_number}` : null;
      }

      const [orderId] = await trx.table('pos_orders').insert({
        outlet_id: outlet.id,
        terminal_id: null,
        opened_by_user_id: null,
        table_label: tableLabel,
        source: 'guest',
      });

      for (const { menuItem, quantity, modifiers } of resolvedItems) {
        await trx.table('pos_order_items').insert({
          pos_order_id: orderId,
          menu_item_id: menuItem.id,
          quantity,
          unit_price: menuItem.price,
          modifiers,
        });
      }

      const [guestOrderId] = await trx.table('pos_guest_orders').insert({
        pos_order_id: orderId,
        token_id: lockedToken.id,
        guest_contact: guestContact ?? null,
        guest_name: guestName ?? null,
        payment_method: paymentMethod,
      });

      // A card order's payment intent is created in the SAME transaction
      // as the order itself — no separate "initiate checkout" step or
      // second idempotency key is ever exposed to the guest (the
      // blueprint's own route list names none), mirroring
      // `portal/service.js`'s `createBookingWithPayment` exactly: the
      // local intent is part of one atomic creation; only the REAL
      // external call (below, in `startGuestOrderCheckout`, called by the
      // controller right after this resolves) happens outside a
      // transaction (ARCHITECTURE.md §6.4).
      if (paymentMethod === 'card') {
        const property = await trx.table('properties').where({ id: context.propertyId }).first('current_business_date', 'base_currency');
        const allTaxRows = await trx.table('taxes');
        const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate: property?.current_business_date, chargeType: 'pos_charge' });
        const { netAmount, taxLines } = computeChargeWithTax({ baseAmount: cartTotal, taxVersions });
        const total = sumMoney([netAmount, sumMoney(taxLines.map((t) => t.amount))]);
        await cashieringService.initiatePosOrderPaystackPaymentIntent({
          trx,
          posOrderId: orderId,
          amount: total,
          currency: property.base_currency,
          idempotencyKey,
        });
      }

      const guestOrder = await trx.table('pos_guest_orders').where({ id: guestOrderId }).first();
      return { status: 201, body: { data: guestOrder } };
    },
  });
}

async function getGuestOrderForToken({ context, token, id }) {
  const db = scopedDb().for(context);
  const row = await db.table('pos_guest_orders').where({ id, token_id: token.id }).first();
  if (!row) return null;
  return resolveEffectiveGuestOrderStatus({ context, guestOrder: row });
}

/** The one payment a card guest order ever creates (mirrors `portal/service.js`'s own "the most recent row is always the right one" comment for `getLatestPaymentForReservation`). */
async function getLatestPaymentForOrder({ context, posOrderId }) {
  const db = scopedDb().for(context);
  return db.table('payments').where({ pos_order_id: posOrderId, settlement_target: 'pos_order' }).orderBy('id', 'desc').first();
}

/**
 * Phase 2 of 2 — the real external Paystack call, deliberately outside
 * any transaction (ARCHITECTURE.md §6.4). Called by the controller
 * immediately after a card order's own `createGuestOrder` response, and
 * again by the guest's own retry path if the first attempt failed to
 * reach the gateway — naturally idempotent, per
 * `startPaystackCheckout`'s own header (a payment not still `INITIATED`
 * is a no-op).
 */
async function startGuestOrderCheckout({ context, guestOrder, callbackUrl }) {
  if (guestOrder.payment_method !== 'card') throw new WrongPaymentMethodError('This order is not set up for card payment.');
  const payment = await getLatestPaymentForOrder({ context, posOrderId: guestOrder.pos_order_id });
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'No payment has been started for this order yet.');
  return cashieringService.startPaystackCheckout({ context, paymentId: payment.id, guestEmail: guestOrder.guest_contact, callbackUrl });
}

async function confirmCardPayment({ context, guestOrder }) {
  assertGuestOrderNotRejected(guestOrder);
  const payment = await getLatestPaymentForOrder({ context, posOrderId: guestOrder.pos_order_id });
  if (!payment) throw new ValidationError('PAYMENT_NOT_FOUND', 'No payment has been started for this order yet.');

  const updated = await cashieringService.verifyPayment({ context, paymentId: payment.id, userId: null });
  return { payment: updated, guestOrder: await getGuestOrderForToken({ context, token: { id: guestOrder.token_id }, id: guestOrder.id }) };
}

// ---------------------------------------------------------------------
// Guest-facing — charge-to-room, the emailed-OTP second factor
// ---------------------------------------------------------------------

async function maskedReservationNameForToken({ context, token }) {
  if (token.type !== 'room') throw new WrongPaymentMethodError('Charge-to-room is only available for a room QR code.');
  const reservation = await reservationsService.findInHouseReservationForRoom({ context, roomId: token.room_id });
  if (!reservation) throw new NoInHouseReservationError();
  return { maskedName: reservationsService.maskGuestName(reservation.guestFirstName, reservation.guestLastName) };
}

async function requestRoomChargeOtp({ context, token, guestOrder }) {
  assertGuestOrderNotRejected(guestOrder);
  if (guestOrder.payment_method !== 'room_charge') throw new WrongPaymentMethodError('This order is not set up for charge-to-room.');
  if (guestOrder.payment_status !== 'unpaid') throw new OrderAlreadyPaidError();

  const reservation = await reservationsService.findInHouseReservationForRoom({ context, roomId: token.room_id });
  if (!reservation) throw new NoInHouseReservationError();

  const db = scopedDb().for(context);
  let devOnlyCode = null;

  await db.transaction(async (trx) => {
    // Supersede any still-outstanding code for this order — a repeat
    // request while already mid-challenge invalidates the earlier code
    // rather than leaving two simultaneously "valid" ones, the same rule
    // `staffLogin`'s own MFA-code issuance already establishes.
    await trx.table('pos_room_charge_otps').where({ pos_order_id: guestOrder.pos_order_id }).whereNull('used_at').delete();

    const { code, hash } = generateOtpCode();
    await trx.table('pos_room_charge_otps').insert({
      reservation_id: reservation.reservationId,
      pos_order_id: guestOrder.pos_order_id,
      code_hash: hash,
      expires_at: minutesFromNow(OTP_TTL_MINUTES),
    });

    // Outside production only — the same dev-only-disclosure precedent
    // every other credential flow in this codebase establishes, kept
    // deliberately simple here (no further narrowing by whether a real
    // email adapter is configured, unlike `staffLogin`'s own MFA code —
    // a real, minor divergence flagged rather than silently matched).
    if (process.env.NODE_ENV !== 'production') devOnlyCode = code;

    const property = await trx.table('properties').where({ id: context.propertyId }).first('name');
    await writeOutboxEvent({
      trx,
      eventType: 'pos.room_charge_otp_requested',
      aggregateType: 'pos_room_charge_otps',
      aggregateId: reservation.reservationId,
      propertyId: context.propertyId,
      payload: { recipientEmail: reservation.guestEmail, code, expiresInMinutes: OTP_TTL_MINUTES, propertyName: property?.name ?? '' },
    });
  });

  // Best-effort reactive dispatch trigger, fired after commit — the same
  // "never fails the request, the periodic sweep is the durable fallback"
  // shape `runIdempotentMutation`/`staffLogin`'s own MFA-code path use.
  enqueueOutboxDispatch({ tenantId: context.tenantId, propertyId: context.propertyId }).catch((error) => {
    console.error('Failed to enqueue outbox dispatch for room-charge OTP (will be caught by the periodic sweep):', error);
  });

  return { devOnlyCode };
}

async function verifyRoomChargeOtpAndSettle({ context, guestOrder, code }) {
  assertGuestOrderNotRejected(guestOrder);
  if (guestOrder.payment_method !== 'room_charge') throw new WrongPaymentMethodError('This order is not set up for charge-to-room.');
  if (guestOrder.payment_status !== 'unpaid') throw new OrderAlreadyPaidError();

  const db = scopedDb().for(context);

  const pending = await db
    .table('pos_room_charge_otps')
    .where({ pos_order_id: guestOrder.pos_order_id })
    .whereNull('used_at')
    .orderBy('id', 'desc')
    .first();

  const fail = () => {
    throw new OtpInvalidError();
  };

  if (!pending) return fail();
  if (new Date(pending.expires_at) <= new Date()) return fail();
  if (pending.attempts >= OTP_MAX_ATTEMPTS) return fail();

  if (hashOtpCode(code) !== pending.code_hash) {
    // Plain read-then-write, not a raw SQL increment — the scoped
    // accessor exposes no raw-knex passthrough (CLAUDE.md). A rare
    // concurrent-guess race under-counting this by one only affects how
    // soon the attempts cap trips; `expires_at`/the single-use `used_at`
    // claim below remain the real, separately-enforced boundaries.
    await db.table('pos_room_charge_otps').where({ id: pending.id }).whereNull('used_at').update({ attempts: pending.attempts + 1 });
    return fail();
  }

  // The single-use claim (ARCHITECTURE.md §5) — a conditional UPDATE with
  // an affected-row check, not read-then-write, the same shape
  // `verifyStaffMfa`/`completePasswordReset` both already use. Guards the
  // case two concurrent submissions of the same correct code both pass
  // the hash comparison above.
  const claimed = await db.table('pos_room_charge_otps').where({ id: pending.id }).whereNull('used_at').update({ used_at: new Date() });
  if (claimed === 0) return fail();

  const reservation = await db.table('reservations').where({ id: pending.reservation_id }).first();
  // Re-verified at the moment of settlement, not trusted from OTP-request
  // time — a guest could linger with an unpaid order across a check-out.
  if (!reservation || reservation.status !== 'checked_in') throw new NoInHouseReservationError();

  const settled = await db.transaction((trx) =>
    posService.settleOrder({
      trx,
      orderId: guestOrder.pos_order_id,
      settledByUserId: null,
      settlements: [
        {
          method: 'room_charge',
          roomCharge: {
            reservationId: reservation.id,
            authMethod: 'guest_otp',
            authReference: `OTP verified for guest order ${guestOrder.id}`,
          },
        },
      ],
    })
  );

  await db.table('pos_guest_orders').where({ id: guestOrder.id }).update({ payment_status: 'charged_to_room', status: 'received' });

  return { order: settled.order, settlements: settled.settlements, guestOrder: await db.table('pos_guest_orders').where({ id: guestOrder.id }).first() };
}

// ---------------------------------------------------------------------
// The lazy auto-reject check — resolved on every read, never a job
// ---------------------------------------------------------------------

/**
 * Code-review fix (CRITICAL) — an `unpaid` guest order (still
 * `awaiting_payment`, or `received` in a hypothetical future shape that
 * reaches that status before payment completes) never actually settled
 * anything, so there is no payment/settlement to refund — but leaving the
 * underlying `pos_orders` tab `open` and any still-`INITIATED`/`PENDING`
 * `payments` row alive is exactly the gap this fix closes: a delayed
 * webhook, the guest's own confirm-payment retry, or an OTP verify could
 * otherwise still complete a real capture/settlement against an order
 * staff have already turned away.
 *
 * Cancelling the payment uses the SAME conditional-UPDATE idiom
 * `applyGatewayResult`'s own claim already uses (`whereIn`/`whereNotIn`
 * status, ARCHITECTURE.md §5) — whichever of "cancel" or "capture" reaches
 * the `payments` row first wins outright. If capture already won the race
 * by the time this runs (0 rows affected, or the underlying order is no
 * longer `open` once we go to void it), the order genuinely settled
 * despite the reject attempt — reload the guest order fresh and fall
 * through to the ordinary already-settled reversal below instead of
 * failing to void an order that no longer exists to void.
 */
async function cancelUnsettledGuestOrderPayment({ context, guestOrder, reason, userId }) {
  const db = scopedDb().for(context);

  if (guestOrder.payment_method === 'card') {
    const payment = await db
      .table('payments')
      .where({ pos_order_id: guestOrder.pos_order_id, settlement_target: 'pos_order' })
      .whereIn('status', ['INITIATED', 'PENDING'])
      .orderBy('id', 'desc')
      .first();
    if (payment) {
      await db.table('payments').where({ id: payment.id }).whereIn('status', ['INITIATED', 'PENDING']).update({ status: 'CANCELLED' });
    }
  }

  const order = await db.table('pos_orders').where({ id: guestOrder.pos_order_id }).first();
  if (order && order.status === 'open') {
    try {
      await posService.voidOrder({ context, orderId: order.id, reason, userId });
      return null; // nothing was ever captured — `payment_status` correctly stays 'unpaid'.
    } catch (error) {
      // Lost the race between our plain read above and `voidOrder`'s own
      // locked re-check — a concurrent capture/settlement won in that
      // narrow window. Fall through to the reload below rather than
      // surface this as an unhandled error.
      if (!(error instanceof OrderNotOpenError)) throw error;
    }
  }

  // Lost the race — a concurrent capture/settlement completed anyway.
  // Reload the guest order's own now-current fields and let the caller's
  // ordinary already-settled reversal handle it.
  return db.table('pos_guest_orders').where({ id: guestOrder.id }).first();
}

/**
 * The reversal both a staff-triggered reject AND a lazy auto-reject use:
 * card-paid -> a real, full `refundPayment` (which itself now knows how
 * to unwind a `pos_order`-target payment, see `cashiering/service.js`);
 * room-charge-paid -> void the settlement directly (no `payments` row
 * exists for that method at all); still-unpaid -> cancel the in-flight
 * payment (if any) and void the still-open underlying tab
 * (`cancelUnsettledGuestOrderPayment`, above) — the CRITICAL code-review
 * fix, since an unpaid order left `open` could otherwise still be
 * captured/charged after being rejected. Either way `pos_guest_orders`'s
 * own `payment_status` becomes `refunded` once something real was
 * actually reversed — a guest order is always reversed in full, never
 * partially, and never resurrected.
 */
async function reverseGuestOrderPayment({ context, guestOrder, reason, userId }) {
  const db = scopedDb().for(context);

  if (guestOrder.payment_status === 'unpaid') {
    const reloaded = await cancelUnsettledGuestOrderPayment({ context, guestOrder, reason, userId });
    if (!reloaded) return; // genuinely never paid — nothing further to reverse.
    guestOrder = reloaded;
  }

  if (guestOrder.payment_method === 'card' && guestOrder.payment_status === 'paid') {
    const payment = await db
      .table('payments')
      .where({ pos_order_id: guestOrder.pos_order_id, settlement_target: 'pos_order', status: 'CAPTURED' })
      .orderBy('id', 'desc')
      .first();
    if (payment) {
      await cashieringService.refundPayment({
        context,
        paymentId: payment.id,
        reason,
        idempotencyKey: `qr-reversal-${guestOrder.id}`,
        userId,
      });
    }
  } else if (guestOrder.payment_method === 'room_charge' && guestOrder.payment_status === 'charged_to_room') {
    const settlement = await db
      .table('pos_order_settlements')
      .where({ pos_order_id: guestOrder.pos_order_id, method: 'room_charge' })
      .whereNull('voided_at')
      .first();
    if (settlement) {
      await db.transaction((trx) => posService.voidSettlement({ trx, settlementId: settlement.id, reason, userId }));
    }
  }

  if (guestOrder.payment_status === 'paid' || guestOrder.payment_status === 'charged_to_room') {
    await db.table('pos_guest_orders').where({ id: guestOrder.id }).update({ payment_status: 'refunded' });
  }
}

async function tryAutoReject({ context, guestOrder }) {
  const db = scopedDb().for(context);
  // Conditional UPDATE + affected-row check (ARCHITECTURE.md §5) — exactly
  // one of two concurrent callers racing past the same timeout (a guest
  // polling their own order, staff loading the queue) gets to claim the
  // transition; the other sees 0 rows affected and simply re-reads the
  // row the winner already updated.
  const claimed = await db
    .table('pos_guest_orders')
    .where({ id: guestOrder.id, status: 'received' })
    .whereNull('accepted_at')
    .update({ status: 'auto_rejected', rejected_reason: 'Not accepted within the outlets configured time window.' });

  if (claimed === 0) {
    return db.table('pos_guest_orders').where({ id: guestOrder.id }).first();
  }

  await reverseGuestOrderPayment({ context, guestOrder, reason: 'Auto-rejected: not accepted within the outlets configured time window.', userId: null });
  return db.table('pos_guest_orders').where({ id: guestOrder.id }).first();
}

/**
 * Called on EVERY read of a guest order — never a job. An order sitting
 * `received` with no `accepted_at`, past its outlet's own configured
 * timeout, is claimed and reversed right here, lazily — the same
 * "recovery evaluated lazily, no background sweeping monitor" precedent
 * Night Audit's own header already establishes.
 *
 * `updated_at` stands in for "the moment this order became received" —
 * no new column was added to track that separately, since the
 * `awaiting_payment -> received` transition IS the last write this row
 * sees before staff act on it (accept/reject/auto-reject), so
 * `updated_at`'s own `ON UPDATE CURRENT_TIMESTAMP` already marks it
 * precisely.
 */
async function resolveEffectiveGuestOrderStatus({ context, guestOrder }) {
  if (guestOrder.status !== 'received' || guestOrder.accepted_at) return guestOrder;

  const db = scopedDb().for(context);
  const order = await db.table('pos_orders').where({ id: guestOrder.pos_order_id }).first();
  const outlet = await db.table('pos_outlets').where({ id: order.outlet_id }).first();
  const timeoutMs = outlet.guest_order_accept_timeout_minutes * 60 * 1000;
  const becameReceivedAt = new Date(guestOrder.updated_at).getTime();
  if (Date.now() - becameReceivedAt < timeoutMs) return guestOrder;

  return tryAutoReject({ context, guestOrder });
}

// ---------------------------------------------------------------------
// Staff-facing — tokens
// ---------------------------------------------------------------------

async function createToken({ context, outletId, type, tableLabel, roomId, baseUrl }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  if (type === 'room' && !roomId) {
    throw new ValidationError('MISSING_FIELD', '"room_id" is required for a room token.', [{ field: 'room_id', issue: 'missing' }]);
  }
  if (type === 'room') {
    const room = await db.table('rooms').where({ id: roomId }).first();
    if (!room) throw new ValidationError('ROOM_NOT_FOUND', 'The specified room does not exist at this property.');
  }

  const raw = generateRawToken();
  const [id] = await db.table('pos_order_tokens').insert({
    outlet_id: outletId,
    type,
    table_label: type === 'table' ? (tableLabel ?? null) : null,
    room_id: type === 'room' ? roomId : null,
    token_hash: hashToken(raw),
    token_encrypted: encryptToken(raw),
  });
  const token = await db.table('pos_order_tokens').where({ id }).first();
  const qrImageDataUrl = await renderTokenQrImage(raw, { baseUrl });
  return { token, rawToken: raw, qrImageDataUrl };
}

/** Decrypts every row for re-display/re-print — `pos.manage` only (route-gated); never reachable by a guest. */
async function listTokensForOutlet({ context, outletId }) {
  const db = scopedDb().for(context);
  const query = db.table('pos_order_tokens');
  const rows = await (outletId ? query.where({ outlet_id: outletId }) : query).orderBy('id', 'desc');
  return rows.map((row) => ({ ...row, raw_token: decryptToken(row.token_encrypted) }));
}

/** The old row's own history is kept (rotated_at stamped, active: false) — never deleted, matching ARCHITECTURE.md §8's "void, never delete" instinct applied to a credential. Returns `null` for a nonexistent (or cross-tenant/property) id — the caller maps that to a plain 404, never a 403 that would confirm the row exists (SECURITY.md §2). */
async function regenerateToken({ context, id, baseUrl }) {
  const db = scopedDb().for(context);
  const existing = await db.table('pos_order_tokens').where({ id }).first();
  if (!existing) return null;

  const raw = generateRawToken();
  return db.transaction(async (trx) => {
    await trx.table('pos_order_tokens').where({ id }).update({ active: false, rotated_at: new Date() });
    const [newId] = await trx.table('pos_order_tokens').insert({
      outlet_id: existing.outlet_id,
      type: existing.type,
      table_label: existing.table_label,
      room_id: existing.room_id,
      token_hash: hashToken(raw),
      token_encrypted: encryptToken(raw),
    });
    const token = await trx.table('pos_order_tokens').where({ id: newId }).first();
    const qrImageDataUrl = await renderTokenQrImage(raw, { baseUrl });
    return { token, rawToken: raw, qrImageDataUrl };
  });
}

/** Reversible — the exact same code keeps working once reactivated, unlike a typical one-way revoke (see the migration's own header). Returns `null` for a nonexistent id, same reasoning as `regenerateToken`. */
async function setTokenActive({ context, id, active }) {
  const db = scopedDb().for(context);
  const existing = await db.table('pos_order_tokens').where({ id }).first();
  if (!existing) return null;
  await db.table('pos_order_tokens').where({ id }).update({ active });
  return db.table('pos_order_tokens').where({ id }).first();
}

async function toggleGuestOrdering({ context, outletId, enabled }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  await db.table('pos_outlets').where({ id: outletId }).update({ guest_ordering_enabled: !!enabled });
  return db.table('pos_outlets').where({ id: outletId }).first();
}

async function updateGuestOrderPolicy({ context, outletId, changes }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();

  const allowed = {};
  if (changes.acceptTimeoutMinutes !== undefined) allowed.guest_order_accept_timeout_minutes = changes.acceptTimeoutMinutes;
  if (changes.rateLimitMax !== undefined) allowed.guest_order_rate_limit_max = changes.rateLimitMax;
  if (changes.maxUnpaidValue !== undefined) allowed.guest_order_max_unpaid_value = changes.maxUnpaidValue;

  await db.table('pos_outlets').where({ id: outletId }).update(allowed);
  return db.table('pos_outlets').where({ id: outletId }).first();
}

// ---------------------------------------------------------------------
// Staff-facing — guest order queue
// ---------------------------------------------------------------------

async function listGuestOrders({ context, outletId, status }) {
  const db = scopedDb().for(context);
  let query = db.table('pos_guest_orders').joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_guest_orders.pos_order_id'));
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  const rows = await query
    .select('pos_guest_orders.*', 'pos_orders.table_label', 'pos_orders.outlet_id', 'pos_orders.status as pos_order_status')
    .orderBy('pos_guest_orders.id', 'desc');

  const resolved = await Promise.all(rows.map((row) => resolveEffectiveGuestOrderStatus({ context, guestOrder: row })));
  return status ? resolved.filter((row) => row.status === status) : resolved;
}

async function getGuestOrder({ context, id }) {
  const db = scopedDb().for(context);
  const row = await db.table('pos_guest_orders').where({ id }).first();
  if (!row) return null;
  return resolveEffectiveGuestOrderStatus({ context, guestOrder: row });
}

async function acceptGuestOrder({ context, id }) {
  const row = await getGuestOrder({ context, id });
  if (!row) throw new GuestOrderNotFoundError();
  if (row.status !== 'received') throw new GuestOrderStateConflictError(row.status, 'received');

  const db = scopedDb().for(context);
  const claimed = await db.table('pos_guest_orders').where({ id, status: 'received' }).whereNull('accepted_at').update({ status: 'preparing', accepted_at: new Date() });
  if (claimed === 0) throw new GuestOrderStateConflictError(row.status, 'received');
  return db.table('pos_guest_orders').where({ id }).first();
}

async function markOnTheWay({ context, id }) {
  const row = await getGuestOrder({ context, id });
  if (!row) throw new GuestOrderNotFoundError();
  if (row.status !== 'preparing') throw new GuestOrderStateConflictError(row.status, 'preparing');

  const db = scopedDb().for(context);
  const claimed = await db.table('pos_guest_orders').where({ id, status: 'preparing' }).update({ status: 'on_the_way' });
  if (claimed === 0) throw new GuestOrderStateConflictError(row.status, 'preparing');
  return db.table('pos_guest_orders').where({ id }).first();
}

async function rejectGuestOrder({ context, id, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to reject an order.', [{ field: 'reason', issue: 'missing' }]);
  const row = await getGuestOrder({ context, id });
  if (!row) throw new GuestOrderNotFoundError();
  if (row.status === 'rejected' || row.status === 'auto_rejected') {
    throw new GuestOrderStateConflictError(row.status, 'received or preparing');
  }

  const db = scopedDb().for(context);
  const claimed = await db
    .table('pos_guest_orders')
    .where({ id })
    .whereNotIn('status', ['rejected', 'auto_rejected'])
    .update({ status: 'rejected', rejected_reason: reason });
  if (claimed === 0) throw new GuestOrderStateConflictError(row.status, 'received or preparing');

  await reverseGuestOrderPayment({ context, guestOrder: row, reason, userId });
  return db.table('pos_guest_orders').where({ id }).first();
}

module.exports = {
  getMenuForToken,
  sumOpenUnpaidValueForToken,
  createGuestOrder,
  getGuestOrderForToken,
  getLatestPaymentForOrder,
  startGuestOrderCheckout,
  confirmCardPayment,
  maskedReservationNameForToken,
  requestRoomChargeOtp,
  verifyRoomChargeOtpAndSettle,
  resolveEffectiveGuestOrderStatus,
  reverseGuestOrderPayment,
  createToken,
  listTokensForOutlet,
  regenerateToken,
  setTokenActive,
  toggleGuestOrdering,
  updateGuestOrderPolicy,
  listGuestOrders,
  getGuestOrder,
  acceptGuestOrder,
  markOnTheWay,
  rejectGuestOrder,
};
