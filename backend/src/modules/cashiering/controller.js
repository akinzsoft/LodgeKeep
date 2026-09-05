'use strict';

/**
 * HTTP layer for the cashiering module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 *
 * Cash mutations go through `runIdempotentMutation` exactly like every
 * other financial mutation in this codebase. The Paystack checkout path is
 * split into two HTTP-visible steps (`capturePaystackPayment` does BOTH in
 * sequence, `startCheckout` exists separately so a failed external call can
 * be retried without recreating the local payment) — see `service.js`'s own
 * header for why the external call cannot live inside the same transaction
 * the idempotency wrapper opens.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { withIdempotency } = require('../../shared/idempotency');
const { runIdempotentMutation, requireIdempotencyKey } = require('../../shared/mutation');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Folios
// ---------------------------------------------------------------------

async function getFolio(req, res, next) {
  try {
    const folio = await service.getFolio({ context: req.context, id: req.params.folioId });
    if (!folio) return notFound(res);
    const [lineItems, payments] = await Promise.all([
      service.listLineItems({ context: req.context, folioId: folio.id }),
      service.listPaymentsForFolio({ context: req.context, folioId: folio.id }),
    ]);
    res.status(200).json(ok({ ...folio, lineItems, payments }));
  } catch (error) {
    next(error);
  }
}

async function listFoliosForReservation(req, res, next) {
  try {
    const folios = await service.listFoliosForReservation({ context: req.context, reservationId: req.params.reservationId });
    res.status(200).json(ok(folios));
  } catch (error) {
    next(error);
  }
}

async function openAdditionalFolio(req, res, next) {
  try {
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.open_folio',
      entityType: 'folios',
      action: 'create',
      handler: async (trx) => {
        const folio = await service.openAdditionalFolio({ trx, reservationId: req.params.reservationId, billedTo: req.body?.billed_to });
        return { status: 201, body: ok(folio) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function moveLineItem(req, res, next) {
  try {
    const destinationFolioId = require_(req.body, 'destination_folio_id');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.move_line_item',
      entityType: 'folio_line_items',
      entityId: req.params.lineItemId,
      action: 'move',
      handler: async (trx) => {
        const line = await service.moveLineItem({ trx, lineItemId: req.params.lineItemId, destinationFolioId });
        return { status: 200, body: ok(line) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Charges & adjustments
// ---------------------------------------------------------------------

async function postCharge(req, res, next) {
  try {
    const type = require_(req.body, 'type');
    const description = require_(req.body, 'description');
    const amount = require_(req.body, 'amount');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.post_charge',
      entityType: 'folio_line_items',
      action: 'post_charge',
      handler: async (trx) => {
        const result = await service.postCharge({
          trx,
          folioId: req.params.folioId,
          type,
          description,
          amount,
          businessDate: req.body?.business_date,
          userId: req.context.userId,
        });
        return { status: 201, body: ok(result.chargeLine, { taxLines: result.taxLines }) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function postAdjustment(req, res, next) {
  try {
    const description = require_(req.body, 'description');
    const amount = require_(req.body, 'amount');
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.post_adjustment',
      entityType: 'folio_line_items',
      action: 'post_adjustment',
      handler: async (trx) => {
        const line = await service.postAdjustment({
          trx,
          folioId: req.params.folioId,
          description,
          amount,
          relatedLineItemId: req.body?.related_line_item_id,
          businessDate: req.body?.business_date,
          userId: req.context.userId,
          reason,
        });
        return { status: 201, body: ok(line) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function voidLineItem(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.void_line_item',
      entityType: 'folio_line_items',
      entityId: req.params.lineItemId,
      action: 'void',
      handler: async (trx) => {
        const line = await service.voidLineItem({ trx, lineItemId: req.params.lineItemId, reason, userId: req.context.userId });
        return { status: 200, body: ok(line) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------

async function captureCashPayment(req, res, next) {
  try {
    const amount = require_(req.body, 'amount');
    const currency = require_(req.body, 'currency');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.capture_cash_payment',
      entityType: 'payments',
      action: 'capture_cash',
      handler: async (trx) => {
        const payment = await service.captureCashPayment({
          trx,
          folioId: req.params.folioId,
          amount,
          currency,
          idempotencyKey: req.get('Idempotency-Key'),
          userId: req.context.userId,
          businessDate: req.body?.business_date,
        });
        return { status: 201, body: ok(payment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Both phases in one HTTP action (see file header): the local intent is
 * idempotency-guarded; the checkout call that follows is not (it is
 * naturally idempotent — see `service.js`'s `startPaystackCheckout`), and a
 * failure there does not lose the created payment row, only the
 * `authorization_url` in THIS response — `startCheckout` below retries it.
 */
async function capturePaystackPayment(req, res, next) {
  try {
    const amount = require_(req.body, 'amount');
    const currency = require_(req.body, 'currency');
    const guestEmail = require_(req.body, 'guest_email');
    const key = requireIdempotencyKey(req);

    const intentOutcome = await withIdempotency({
      context: req.context,
      operationType: 'cashiering.initiate_paystack_payment',
      key,
      payload: req.body,
      handler: async (trx) => {
        const payment = await service.initiatePaystackPaymentIntent({ trx, folioId: req.params.folioId, amount, currency, idempotencyKey: key });
        return { status: 201, body: ok(payment) };
      },
    });
    const intentResult = intentOutcome.body.data;
    if (!intentOutcome.replayed) {
      await req.audit({ entityType: 'payments', entityId: intentResult.id, action: 'initiate_paystack_payment', afterState: intentResult });
    }

    try {
      const { payment, authorizationUrl } = await service.startPaystackCheckout({
        context: req.context,
        paymentId: intentResult.id,
        guestEmail,
        callbackUrl: req.body?.callback_url,
      });
      if (!intentOutcome.replayed) {
        await req.audit({ entityType: 'payments', entityId: payment.id, action: 'start_checkout', afterState: payment });
      }
      res.status(201).json(ok(payment, { authorizationUrl }));
    } catch (checkoutError) {
      // The local intent is real and saved; only starting checkout with the
      // gateway failed. Surface both facts rather than a bare 500 — the
      // client can retry via POST .../payments/:id/start-checkout.
      res.status(202).json(ok(intentResult, { checkoutError: checkoutError.message, retry: `/cashiering/payments/${intentResult.id}/start-checkout` }));
    }
  } catch (error) {
    next(error);
  }
}

async function startCheckout(req, res, next) {
  try {
    const payment = await service.getPayment({ context: req.context, id: req.params.id });
    if (!payment) return notFound(res);
    const result = await service.startPaystackCheckout({
      context: req.context,
      paymentId: req.params.id,
      guestEmail: require_(req.body, 'guest_email'),
      callbackUrl: req.body?.callback_url,
    });
    res.status(200).json(ok(result.payment, { authorizationUrl: result.authorizationUrl }));
  } catch (error) {
    next(error);
  }
}

async function verifyPayment(req, res, next) {
  try {
    const payment = await service.getPayment({ context: req.context, id: req.params.id });
    if (!payment) return notFound(res);
    const updated = await service.verifyPayment({ context: req.context, paymentId: req.params.id, userId: req.context.userId });
    await req.audit({ entityType: 'payments', entityId: updated.id, action: 'verify', beforeState: payment, afterState: updated });
    res.status(200).json(ok(updated));
  } catch (error) {
    next(error);
  }
}

async function refundPayment(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'cashiering.refund_payment',
      entityType: 'payments',
      action: 'refund',
      handler: async () => {
        // ARCHITECTURE.md §6.4: the real gateway call cannot live inside the
        // idempotency transaction — `refundPayment` opens its own around
        // just the local writes, matching `startPaystackCheckout`'s split.
        const payment = await service.refundPayment({
          context: req.context,
          paymentId: req.params.id,
          amount: req.body?.amount,
          reason,
          idempotencyKey: req.get('Idempotency-Key'),
          userId: req.context.userId,
        });
        return { status: 201, body: ok(payment) };
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Public — no staff auth (API.md §7, mounted before `authenticate('staff')`
 * in `src/app.js`). Verified by signature, not by bearer token.
 * `req.rawBody` is captured by `src/app.js`'s raw-body-preserving JSON
 * parser for exactly this route (Paystack's HMAC is over the raw bytes).
 */
async function receivePaystackWebhook(req, res, next) {
  try {
    await service.handlePaystackWebhook({
      rawBody: req.rawBody ?? JSON.stringify(req.body),
      signatureHeader: req.get('x-paystack-signature'),
      parsedBody: req.body,
    });
    // API.md §7: respond 200 once persisted, regardless of processing outcome.
    res.status(200).json(ok({ received: true }));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getFolio,
  listFoliosForReservation,
  openAdditionalFolio,
  moveLineItem,
  postCharge,
  postAdjustment,
  voidLineItem,
  captureCashPayment,
  capturePaystackPayment,
  startCheckout,
  verifyPayment,
  refundPayment,
  receivePaystackWebhook,
};
