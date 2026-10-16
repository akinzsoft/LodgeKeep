'use strict';

/**
 * HTTP layer for discounts, comps and their reasons/limits. The money is the server's: a request names a scope, a
 * type, a value and a reason, never an amount. Creating a request, approving it and removing it each leave an audit
 * row (actor, before/after, reason); an approved discount is never edited, only removed before settlement.
 */

const { ok } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
const { scopedDb } = require('../../db');
const { assertPermission } = require('../../auth');
const { PermissionDeniedError } = require('../../auth/errors');
const { outletScopeForUser, scopeCovers } = require('../../shared/outlet-assignments');
const { toCsv } = require('../reporting/service');
const { claimApproval } = require('../approvals');
const posService = require('../pos/service');
const supermarketService = require('../supermarket/service');
const service = require('./service');
const { computeDiscountReport, CSV_COLUMNS } = require('./report');
const errors = require('./errors');

async function holdsPermission(context, key) {
  try {
    await assertPermission(context, key);
    return true;
  } catch (error) {
    if (error instanceof PermissionDeniedError) return false;
    throw error;
  }
}

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------- reasons and limits

const listReasons = wrap(async (req, res) => {
  const includeArchived = req.query?.include_archived === 'true' && (await holdsPermission(req.context, 'discount.manage'));
  res.status(200).json(ok(await service.listReasons({ context: req.context, includeArchived })));
});

const createReason = wrap(async (req, res) => {
  const db = scopedDb().for(req.context);
  const reason = await service.createReason({ db, input: req.body ?? {} });
  await req.audit({ entityType: 'discount_reasons', entityId: reason.id, action: 'create', afterState: reason });
  res.status(201).json(ok(reason));
});

const updateReason = wrap(async (req, res) => {
  const db = scopedDb().for(req.context);
  const { before, after } = await service.updateReason({ db, id: req.params.id, input: req.body ?? {} });
  if (before !== after) await req.audit({ entityType: 'discount_reasons', entityId: after.id, action: 'update', beforeState: before, afterState: after });
  res.status(200).json(ok(after));
});

const listLimits = wrap(async (req, res) => {
  res.status(200).json(ok(await service.listLimits({ db: scopedDb().for(req.context) })));
});

const setLimit = wrap(async (req, res) => {
  const result = await scopedDb().for(req.context).transaction((trx) => service.setLimit({ trx, role: req.params.role, maxPercent: req.body?.max_percent, userId: req.context.userId }));
  if (result.before !== result.after) {
    await req.audit({ entityType: 'discount_limits', entityId: null, action: 'set_limit', beforeState: { role: result.role, max_percent: result.before }, afterState: { role: result.role, max_percent: result.after } });
  }
  res.status(200).json(ok({ role: result.role, max_percent: result.after }));
});

// ---------------------------------------------------------------- discounts on a check

/** The tab-owner rule, exactly as the Register applies it to adding items. */
async function tabRule(req) {
  const actor = {
    userId: req.context.userId,
    canActForOthers: await holdsPermission(req.context, 'pos.manage'),
    overrideReason: posService.cleanOverrideReason(req.body?.override_reason),
  };
  return { actor, assertTab: (order) => posService.assertCanChangeTab(order, actor) };
}

const listOrderDiscounts = wrap(async (req, res) => {
  res.status(200).json(ok(await service.listOrderDiscounts({ db: scopedDb().for(req.context), orderId: req.params.id })));
});

const createOrderDiscount = wrap(async (req, res) => {
  const { actor, assertTab } = await tabRule(req);
  let override = {};
  await runIdempotentMutation(req, res, {
    operationType: 'discounts.create_order_discount',
    entityType: 'discounts',
    action: 'discount_request',
    auditExtras: () => override,
    handler: async (trx) => {
      const { discount, amount, approvalRequired, approvalAction, ownerOverride } = await service.createOrderDiscount({
        trx,
        orderId: req.params.id,
        raw: req.body ?? {},
        userId: req.context.userId,
        assertTab,
      });
      override = ownerOverride == null ? {} : { reason: actor.overrideReason, afterState: { owner_user_id: ownerOverride } };
      return { status: 201, body: ok({ ...discount, amount, approvalRequired, approvalAction }) };
    },
  });
});

/** A discount's outlet must be one the caller covers (staff outlet assignments); anything else reads as not found. */
async function requireDiscountInScope(req, discountId) {
  const db = scopedDb().for(req.context);
  const row = await db.table('discounts').where({ id: discountId }).first('id', 'outlet_id');
  if (!row) throw new errors.DiscountNotFoundError();
  if (!req.context.isImpersonation) {
    const scope = await outletScopeForUser(db, req.context.userId);
    if (!scopeCovers(scope, [row.outlet_id])) throw new errors.DiscountNotFoundError();
  }
  return row;
}

const getDiscount = wrap(async (req, res) => {
  await requireDiscountInScope(req, req.params.id);
  res.status(200).json(ok(await service.getDiscount({ db: scopedDb().for(req.context), discountId: req.params.id })));
});

const approveDiscount = wrap(async (req, res) => {
  const db = scopedDb().for(req.context);
  const { row, action } = await (async () => {
    const found = await requireDiscountInScope(req, req.params.id);
    const outlet = await db.table('pos_outlets').where({ id: found.outlet_id }).first();
    return { row: found, action: service.approvalActionFor(outlet) };
  })();
  await runIdempotentMutation(req, res, {
    operationType: 'discounts.approve_discount',
    entityType: 'discounts',
    entityId: row.id,
    action: 'discount_approve',
    handler: async (trx) => {
      // The manager's approval is claimed first, inside this transaction: a refusal after it rolls the claim back.
      const approval = await claimApproval(req, trx, action, req.params.id);
      const { after } = await service.approveDiscount({ trx, discountId: req.params.id, approverUserId: approval.approverUserId, approvalId: approval.approvalId });
      return { status: 200, body: ok({ ...after, approved_by_user_id: String(after.approved_by_user_id) }) };
    },
  });
});

const removeDiscount = wrap(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to remove a discount.', [{ field: 'reason', issue: 'missing' }]);
  await requireDiscountInScope(req, req.params.id);
  const { actor, assertTab } = await tabRule(req);
  const outcome = await scopedDb().for(req.context).transaction((trx) => service.removeDiscount({ trx, discountId: req.params.id, userId: req.context.userId, reason, assertTab }));
  await req.audit({
    entityType: 'discounts',
    entityId: req.params.id,
    action: 'discount_remove',
    beforeState: outcome.before,
    afterState: outcome.ownerOverride == null ? outcome.after : { ...outcome.after, owner_user_id: outcome.ownerOverride },
    reason: outcome.ownerOverride == null ? reason : `${reason} (${actor.overrideReason})`,
  });
  res.status(200).json(ok(outcome.after));
});

// ---------------------------------------------------------------- supermarket cart-bound requests

const createCartDiscount = wrap(async (req, res) => {
  await runIdempotentMutation(req, res, {
    operationType: 'discounts.create_cart_discount',
    entityType: 'discounts',
    action: 'discount_request',
    handler: async (trx) => {
      const outlet = await supermarketService.requireSupermarketOutlet({ db: trx, context: req.context, outletId: req.body?.outlet_id });
      const { discount, amount, approvalRequired, approvalAction } = await service.createCartDiscount({ trx, outlet, cart: req.body?.items, raw: req.body ?? {}, userId: req.context.userId });
      return { status: 201, body: ok({ ...discount, amount, approvalRequired, approvalAction }) };
    },
  });
});

// ---------------------------------------------------------------- report

const report = wrap(async (req, res) => {
  const result = await computeDiscountReport({ db: scopedDb().for(req.context), dateFrom: req.query?.date_from, dateTo: req.query?.date_to, outletId: req.query?.outlet_id ?? null });
  if (req.query?.format === 'csv') {
    res
      .status(200)
      .set('Content-Type', 'text/csv')
      .set('Content-Disposition', `attachment; filename="discounts-${result.dateFrom}-to-${result.dateTo}.csv"`)
      .send(toCsv(result.lines, CSV_COLUMNS));
    return;
  }
  res.status(200).json(ok(result));
});

module.exports = {
  listReasons,
  createReason,
  updateReason,
  listLimits,
  setLimit,
  listOrderDiscounts,
  createOrderDiscount,
  getDiscount,
  approveDiscount,
  removeDiscount,
  createCartDiscount,
  report,
};
