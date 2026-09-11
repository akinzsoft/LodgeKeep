'use strict';

/**
 * HTTP layer for the staff-facing half of QR self-ordering — PLAN.md
 * Phase 6. Mounted inside `buildStaffRouter()`, after `authenticate('staff')`
 * and `attachAudit()`, same as every other business module — see
 * `routes.js`'s own RBAC header for the `pos.operate`/`pos.manage` split.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

/** The base URL a guest's browser reaches this tenant's own subdomain at — the frontend's own QR-ordering route prefix is appended by `tokens.js`'s `renderTokenQrImage`. Not derivable from `req` alone (Host header carries the STAFF console's own origin, not necessarily the guest-facing one), so the caller supplies it explicitly. */
function baseUrlFrom(req) {
  return req.body?.base_url ?? req.query?.base_url ?? `${req.protocol}://${req.get('host')}/qr-order`;
}

async function listTokens(req, res, next) {
  try {
    res.status(200).json(ok(await service.listTokensForOutlet({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function createToken(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const type = require_(req.body, 'type');
    const result = await service.createToken({
      context: req.context,
      outletId,
      type,
      tableLabel: req.body?.table_label,
      roomId: req.body?.room_id,
      baseUrl: baseUrlFrom(req),
    });
    await req.audit({ entityType: 'pos_order_tokens', entityId: result.token.id, action: 'create', afterState: result.token });
    res.status(201).json(ok({ token: result.token, qrImageDataUrl: result.qrImageDataUrl }, { rawToken: result.rawToken }));
  } catch (error) {
    next(error);
  }
}

async function regenerateToken(req, res, next) {
  try {
    const result = await service.regenerateToken({ context: req.context, id: req.params.id, baseUrl: baseUrlFrom(req) });
    if (!result) return notFound(res);
    await req.audit({ entityType: 'pos_order_tokens', entityId: result.token.id, action: 'regenerate', afterState: result.token });
    res.status(201).json(ok({ token: result.token, qrImageDataUrl: result.qrImageDataUrl }, { rawToken: result.rawToken }));
  } catch (error) {
    next(error);
  }
}

async function deactivateToken(req, res, next) {
  try {
    const token = await service.setTokenActive({ context: req.context, id: req.params.id, active: false });
    if (!token) return notFound(res);
    await req.audit({ entityType: 'pos_order_tokens', entityId: token.id, action: 'deactivate', afterState: token });
    res.status(200).json(ok(token));
  } catch (error) {
    next(error);
  }
}

/** Reversible, by design — see `pos_order_tokens`' own migration header. */
async function reactivateToken(req, res, next) {
  try {
    const token = await service.setTokenActive({ context: req.context, id: req.params.id, active: true });
    if (!token) return notFound(res);
    await req.audit({ entityType: 'pos_order_tokens', entityId: token.id, action: 'reactivate', afterState: token });
    res.status(200).json(ok(token));
  } catch (error) {
    next(error);
  }
}

async function toggleGuestOrdering(req, res, next) {
  try {
    if (req.body?.enabled === undefined) throw new ValidationError('MISSING_FIELD', '"enabled" is required.', [{ field: 'enabled', issue: 'missing' }]);
    const outlet = await service.toggleGuestOrdering({ context: req.context, outletId: req.params.id, enabled: req.body.enabled });
    await req.audit({ entityType: 'pos_outlets', entityId: outlet.id, action: 'toggle_guest_ordering', afterState: outlet });
    res.status(200).json(ok(outlet));
  } catch (error) {
    next(error);
  }
}

async function updateGuestOrderPolicy(req, res, next) {
  try {
    const outlet = await service.updateGuestOrderPolicy({
      context: req.context,
      outletId: req.params.id,
      changes: {
        acceptTimeoutMinutes: req.body?.accept_timeout_minutes,
        rateLimitMax: req.body?.rate_limit_max,
        maxUnpaidValue: req.body?.max_unpaid_value,
      },
    });
    await req.audit({ entityType: 'pos_outlets', entityId: outlet.id, action: 'update_guest_order_policy', afterState: outlet });
    res.status(200).json(ok(outlet));
  } catch (error) {
    next(error);
  }
}

async function listGuestOrders(req, res, next) {
  try {
    res.status(200).json(ok(await service.listGuestOrders({ context: req.context, outletId: req.query.outlet_id, status: req.query.status })));
  } catch (error) {
    next(error);
  }
}

async function getGuestOrder(req, res, next) {
  try {
    const guestOrder = await service.getGuestOrder({ context: req.context, id: req.params.id });
    if (!guestOrder) return notFound(res);
    res.status(200).json(ok(guestOrder));
  } catch (error) {
    next(error);
  }
}

async function acceptGuestOrder(req, res, next) {
  try {
    const guestOrder = await service.acceptGuestOrder({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_guest_orders', entityId: guestOrder.id, action: 'accept', afterState: guestOrder });
    res.status(200).json(ok(guestOrder));
  } catch (error) {
    next(error);
  }
}

async function markOnTheWay(req, res, next) {
  try {
    const guestOrder = await service.markOnTheWay({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_guest_orders', entityId: guestOrder.id, action: 'mark_on_the_way', afterState: guestOrder });
    res.status(200).json(ok(guestOrder));
  } catch (error) {
    next(error);
  }
}

async function rejectGuestOrder(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const guestOrder = await service.rejectGuestOrder({ context: req.context, id: req.params.id, reason, userId: req.context.userId });
    await req.audit({ entityType: 'pos_guest_orders', entityId: guestOrder.id, action: 'reject', afterState: guestOrder, reason });
    res.status(200).json(ok(guestOrder));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listTokens,
  createToken,
  regenerateToken,
  deactivateToken,
  reactivateToken,
  toggleGuestOrdering,
  updateGuestOrderPolicy,
  listGuestOrders,
  getGuestOrder,
  acceptGuestOrder,
  markOnTheWay,
  rejectGuestOrder,
};
