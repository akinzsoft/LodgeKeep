'use strict';

/**
 * HTTP layer for the guest-facing half of QR self-ordering — PLAN.md
 * Phase 6. Parses the request, calls the service, shapes the API.md §2
 * envelope. Every route here is fully anonymous (`resolveQrOrderToken`
 * builds this request's own guest context — see `middleware.js`), so
 * none of this ever reads `req.context.userId`/a role.
 */

const { scopedDb } = require('../../db');
const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { requireIdempotencyKey } = require('../../shared/mutation');
const { checkTokenOrderRateLimit, checkTokenOtpRequestRateLimit, checkTokenOtpVerifyRateLimit } = require('./rate-limit');
const { RateLimitedError } = require('./errors');
const service = require('./service');
// One-way dependency on `portal`, mirroring `service.js`'s own header on
// depending on `pos`/`cashiering`/`reservations` — portal never requires
// this module back, so there is no cycle.
const portalService = require('../portal/service');

/**
 * Code-review fix (IMPORTANT) — the shared "run a per-token rate check,
 * set a real Retry-After on a 429, otherwise propagate any other error
 * unchanged" shape `createOrder`'s own inline try/catch already
 * established for order creation, promoted here once `requestOtp`/
 * `verifyOtp` needed the identical pattern for their own dedicated
 * counters.
 */
async function enforceTokenRateLimit(res, check) {
  try {
    await check();
  } catch (error) {
    if (error instanceof RateLimitedError) {
      res.set('Retry-After', String(error.details.retryAfterSeconds));
    }
    throw error;
  }
}

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function getMenu(req, res, next) {
  try {
    res.status(200).json(ok(await service.getMenuForToken({ context: req.context, token: req.qrToken })));
  } catch (error) {
    next(error);
  }
}

/**
 * User-directed fix: the QR-ordering guest pages are the same class of
 * surface as the guest booking portal (guest-facing, tenant-branded, no
 * login) and must reuse its theming mechanism, not grow a second one.
 * `resolveQrOrderToken()` (middleware.js) already resolves `req.context`
 * to the token's own `propertyId` — the ONLY input
 * `portalService.getPropertyBranding` ever needs — so this calls that
 * exact same function verbatim rather than re-querying `properties`
 * itself. `getPropertyBranding` returns `null` for a property with no row
 * (can't happen here — the token middleware already 404'd on no match —
 * but `notFound` is the correct, established response shape regardless).
 */
async function getBranding(req, res, next) {
  try {
    const branding = await portalService.getPropertyBranding({ context: req.context });
    if (!branding) return notFound(res);
    res.status(200).json(ok(branding));
  } catch (error) {
    next(error);
  }
}

/** Owns both rate-limit tiers for order creation (ARCHITECTURE.md §15's public/guest row): the per-IP limiter runs as Express middleware ahead of this handler (`routes.js`); the per-token cap — a per-outlet, DB-configured value the per-IP limiter can't read — is checked here. */
async function createOrder(req, res, next) {
  try {
    const outlet = await scopedDb().for(req.context).table('pos_outlets').where({ id: req.qrToken.outlet_id }).first('guest_order_rate_limit_max');
    try {
      await checkTokenOrderRateLimit({ tokenHash: req.qrToken.token_hash, max: outlet?.guest_order_rate_limit_max ?? 5 });
    } catch (rateLimitError) {
      if (rateLimitError instanceof RateLimitedError) {
        res.set('Retry-After', String(rateLimitError.details.retryAfterSeconds));
      }
      throw rateLimitError;
    }

    const key = requireIdempotencyKey(req);
    const cart = req.body?.items;
    const paymentMethod = require_(req.body, 'payment_method');

    const outcome = await service.createGuestOrder({
      context: req.context,
      token: req.qrToken,
      cart,
      paymentMethod,
      guestContact: req.body?.guest_contact,
      guestName: req.body?.guest_name,
      idempotencyKey: key,
    });
    const guestOrder = outcome.body.data;

    if (!outcome.replayed) {
      await req.audit({ entityType: 'pos_guest_orders', entityId: guestOrder.id, action: 'guest_create_order', afterState: guestOrder });
    }

    if (paymentMethod !== 'card') {
      res.status(outcome.status).json(outcome.body);
      return;
    }

    // The blueprint's own route list names no separate "initiate
    // checkout" endpoint — mirroring `portal/controller.js`'s own
    // `respondWithCheckout` exactly: the real Paystack call happens right
    // here, immediately after order creation, with the identical honest
    // 202 partial-success shape on a gateway failure (the local order is
    // still real and already committed; `confirm-payment` below is the
    // guest's own retry path once they have a working connection again).
    try {
      const { payment, authorizationUrl, accessCode } = await service.startGuestOrderCheckout({
        context: req.context,
        guestOrder,
        callbackUrl: req.body?.callback_url,
      });
      res.status(outcome.status).json(ok({ ...guestOrder, payment }, { authorizationUrl, accessCode }));
    } catch (checkoutError) {
      res.status(202).json(
        ok(guestOrder, { checkoutError: checkoutError.message, retry: `/qr-order/${req.params.token}/orders/${guestOrder.id}/confirm-payment` })
      );
    }
  } catch (error) {
    next(error);
  }
}

async function getOrderStatus(req, res, next) {
  try {
    const guestOrder = await service.getGuestOrderForToken({ context: req.context, token: req.qrToken, id: req.params.id });
    if (!guestOrder) return notFound(res);
    res.status(200).json(ok(guestOrder));
  } catch (error) {
    next(error);
  }
}

/** Every action below targets a specific order id — resolved (and ownership-checked against the SCANNED token, not just this property) the same way, so each handler gets a real 404 rather than repeating the lookup. */
async function loadOwnGuestOrder(req) {
  return service.getGuestOrderForToken({ context: req.context, token: req.qrToken, id: req.params.id });
}

/**
 * The guest's own retry path when the initial checkout call inside
 * `createOrder` couldn't reach the gateway at all (the 202 partial-
 * success case) — reuses the exact same `startGuestOrderCheckout`,
 * naturally idempotent (`startPaystackCheckout`'s own header: a payment
 * not still `INITIATED` is a no-op). Distinct from `confirmCardPayment`
 * below, which is the guest's browser actually RETURNING from Paystack's
 * hosted page once checkout succeeded in reaching it.
 */
async function retryCheckout(req, res, next) {
  try {
    const guestOrder = await loadOwnGuestOrder(req);
    if (!guestOrder) return notFound(res);
    const { payment, authorizationUrl, accessCode } = await service.startGuestOrderCheckout({
      context: req.context,
      guestOrder,
      callbackUrl: req.body?.callback_url,
    });
    res.status(200).json(ok(payment, { authorizationUrl, accessCode }));
  } catch (error) {
    next(error);
  }
}

/** `POST /qr-order/:token/orders/:id/confirm-payment` — the guest's browser returning from Paystack; re-verifies against the real gateway (covers the case the webhook has not landed yet). */
async function confirmCardPayment(req, res, next) {
  try {
    const guestOrder = await loadOwnGuestOrder(req);
    if (!guestOrder) return notFound(res);
    const result = await service.confirmCardPayment({ context: req.context, guestOrder });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function confirmName(req, res, next) {
  try {
    const guestOrder = await loadOwnGuestOrder(req);
    if (!guestOrder) return notFound(res);
    const result = await service.maskedReservationNameForToken({ context: req.context, token: req.qrToken });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/**
 * Code-review fix (IMPORTANT) — the per-token counter runs FIRST, before
 * even a 404 lookup, since it's keyed on the physical QR token, not this
 * specific order id: any call against this token counts toward its
 * budget regardless of which (or whether a real) order id was named.
 */
async function requestOtp(req, res, next) {
  try {
    await enforceTokenRateLimit(res, () => checkTokenOtpRequestRateLimit({ tokenHash: req.qrToken.token_hash }));
    const guestOrder = await loadOwnGuestOrder(req);
    if (!guestOrder) return notFound(res);
    const result = await service.requestRoomChargeOtp({ context: req.context, token: req.qrToken, guestOrder });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function verifyOtp(req, res, next) {
  try {
    await enforceTokenRateLimit(res, () => checkTokenOtpVerifyRateLimit({ tokenHash: req.qrToken.token_hash }));
    const guestOrder = await loadOwnGuestOrder(req);
    if (!guestOrder) return notFound(res);
    const code = require_(req.body, 'code');
    const result = await service.verifyRoomChargeOtpAndSettle({ context: req.context, guestOrder, code });
    await req.audit({ entityType: 'pos_guest_orders', entityId: guestOrder.id, action: 'guest_charge_to_room', afterState: result.guestOrder });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMenu,
  getBranding,
  createOrder,
  getOrderStatus,
  retryCheckout,
  confirmCardPayment,
  confirmName,
  requestOtp,
  verifyOtp,
};
