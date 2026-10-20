'use strict';

/**
 * Discounts, comps and approval limits (PR 1). A discount is a RULE the server prices: the client names a scope, a type
 * and a value and the server works out the money (shared/discount-pricing.js), so no amount the client sends is ever
 * trusted. A request within its giver's role limit is `active` at once; above the limit, and every comp, it waits as
 * `pending_approval` until a manager approves it with their PIN (`src/modules/approvals`), which binds the approval to
 * this exact row.
 *
 * IMMUTABLE once decided. Nothing here ever updates a discount's scope, type, value, reason, order or line. The only
 * writes after creation are status moves: approve (pending -> active), remove (pending/active -> removed, before the
 * check settles), claim (a supermarket cart request attaches to its sale once) and the settlement's `applied`. A
 * different discount is a new row with its own approval.
 */

const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
const { toCents } = require('../../shared/money');
const { assertDiscountInput } = require('../../shared/discount-input');
const { applyDiscounts, isWithinPercentLimit, effectivePercent } = require('../../shared/discount-pricing');
const { isSupermarketOutlet } = require('../../shared/outlet-types');
const outletMenu = require('../../shared/outlet-menu');
const { roleAtProperty } = require('../../auth/roles');
const { hasPermission } = require('../../auth/rbac');
const posErrors = require('../pos/errors');
const { scopedDb } = require('../../db');
const store = require('./store');
const voucherStore = require('./voucher-store');
const errors = require('./errors');
const { formatVoucherCode } = require('../../shared/voucher-code');

const KINDS = ['discount', 'comp'];
const REASON_KINDS = ['discount', 'comp', 'both'];
const CART_GRANT_TTL_MS = 30 * 60_000;
const MAX_CART_LINES = 100;

// ---------------------------------------------------------------- reasons

async function ensureDefaultReasons(db) {
  // Idempotent per code: a default that is missing is added, one that exists (even archived or renamed) is left alone.
  const present = new Set((await db.table('discount_reasons').select('code')).map((row) => row.code));
  for (const reason of store.DEFAULT_REASONS) {
    if (present.has(reason.code)) continue;
    try {
      await db.table('discount_reasons').insert({ ...reason });
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error; // another request added it first
    }
  }
}

/** The property's reasons; the defaults are created the first time a property asks. */
async function listReasons({ context, includeArchived = false }) {
  const db = scopedDb().for(context);
  await ensureDefaultReasons(db);
  // The property's own "Voucher" reason (kind `voucher`) is not something a cashier picks.
  const query = db.table('discount_reasons').whereNot({ kind: 'voucher' }).orderBy('name');
  return includeArchived ? query : query.where({ status: 'active' });
}

function cleanReasonInput({ code, name, kind }, { partial = false } = {}) {
  const out = {};
  if (!partial || code !== undefined) {
    const value = typeof code === 'string' ? code.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{2,30}$/.test(value)) throw new ValidationError('INVALID_REASON_CODE', '"code" must be 2 to 30 letters, numbers or underscores.', [{ field: 'code', issue: 'invalid' }]);
    out.code = value;
  }
  if (!partial || name !== undefined) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 80) throw new ValidationError('INVALID_REASON_NAME', '"name" is required, at most 80 characters.', [{ field: 'name', issue: 'invalid' }]);
    out.name = value;
  }
  if (!partial || kind !== undefined) {
    if (!REASON_KINDS.includes(kind)) throw new ValidationError('INVALID_REASON_KIND', `"kind" must be one of: ${REASON_KINDS.join(', ')}.`, [{ field: 'kind', issue: 'invalid' }]);
    out.kind = kind;
  }
  return out;
}

async function createReason({ db, input }) {
  const values = cleanReasonInput(input);
  const [id] = await withDuplicateMapping('discount_reason', `A reason with the code "${values.code}" already exists.`, () => db.table('discount_reasons').insert({ ...values, status: 'active' }));
  return db.table('discount_reasons').where({ id }).first();
}

async function updateReason({ db, id, input }) {
  const before = await db.table('discount_reasons').where({ id }).first();
  if (!before) throw new errors.DiscountReasonInvalidError('That reason does not exist.');
  const changes = cleanReasonInput(input, { partial: true });
  if (input.status !== undefined) {
    if (!['active', 'archived'].includes(input.status)) throw new ValidationError('INVALID_REASON_STATUS', '"status" must be active or archived.', [{ field: 'status', issue: 'invalid' }]);
    changes.status = input.status;
  }
  // The code is a stable key; only the label, the kind and the status can change. Past discounts keep their frozen name.
  delete changes.code;
  if (Object.keys(changes).length === 0) return { before, after: before };
  await db.table('discount_reasons').where({ id }).update(changes);
  return { before, after: await db.table('discount_reasons').where({ id }).first() };
}

// ---------------------------------------------------------------- limits

async function listLimits({ db }) {
  const rows = await db.table('discount_limits').select('role_code', 'max_percent');
  const own = new Map(rows.map((row) => [row.role_code, String(row.max_percent)]));
  return store.LIMIT_ROLES.map((role) => ({ role, max_percent: own.get(role) ?? store.DEFAULT_LIMITS[role], is_default: !own.has(role) }));
}

async function setLimit({ trx, role, maxPercent, userId }) {
  if (!store.LIMIT_ROLES.includes(role)) throw new ValidationError('INVALID_ROLE', `"role" must be one of: ${store.LIMIT_ROLES.join(', ')}.`, [{ field: 'role', issue: 'invalid' }]);
  const value = typeof maxPercent === 'string' ? maxPercent.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(value) || toCents(value) > 10000n) throw new errors.DiscountLimitInvalidError();
  const before = await store.limitPercentFor(trx, role);
  const existing = await trx.table('discount_limits').where({ role_code: role }).forUpdate().first('id');
  if (existing) await trx.table('discount_limits').where({ id: existing.id }).update({ max_percent: value, updated_by_user_id: userId });
  else await trx.table('discount_limits').insert({ role_code: role, max_percent: value, updated_by_user_id: userId });
  return { role, before, after: value };
}

// ---------------------------------------------------------------- requests

/** The approval action a manager is asked for, by the kind of outlet the discount is at. */
const approvalActionFor = (outlet) => (isSupermarketOutlet(outlet) ? 'supermarket.discount_approval' : 'pos.discount_approval');

function readInput(raw) {
  const kind = raw?.kind ?? 'discount';
  if (!KINDS.includes(kind)) throw new ValidationError('INVALID_DISCOUNT', `"kind" must be one of: ${KINDS.join(', ')}.`, [{ field: 'kind', issue: 'invalid' }]);
  // A comp is a 100% discount, always: the client's type and value are not read.
  const checked = assertDiscountInput(kind === 'comp' ? { scope: raw?.scope, type: 'percent', value: '100' } : raw);
  return { ...checked, kind };
}

async function loadReasonFor(trx, reasonId, kind) {
  const reason = reasonId ? await trx.table('discount_reasons').where({ id: reasonId }).first() : null;
  if (!reason || reason.status !== 'active') throw new errors.DiscountReasonInvalidError();
  if (reason.kind !== 'both' && reason.kind !== kind) {
    throw new errors.DiscountReasonInvalidError(kind === 'comp' ? 'That reason is not for comps.' : 'That reason is only for comps.');
  }
  return reason;
}

/**
 * Prices the new request against the check as it stands and decides whether it needs a manager. Returns the amount,
 * its effective percent and the status the row starts in.
 */
async function evaluate(trx, { items, activeRows, spec, userId }) {
  const pricing = applyDiscounts({
    items,
    discounts: [...activeRows, { id: 'new', scope: spec.scope, type: spec.type, value: spec.value, menu_item_id: spec.menuItemId ?? null }],
  });
  const entry = pricing.discounts.find((candidate) => candidate.discountId === 'new');
  if (toCents(entry.baseBefore) <= 0n || toCents(entry.amount) <= 0n) throw new errors.DiscountNothingToDiscountError();
  if (spec.kind !== 'comp' && toCents(entry.amount) >= toCents(entry.baseBefore)) throw new errors.DiscountUseCompError();

  const percent = effectivePercent({ amount: entry.amount, base: entry.baseBefore });
  const role = await roleAtProperty(trx, trx.context, userId, trx.context.propertyId);
  const limit = role ? await store.limitPercentFor(trx, role) : '0.00';
  const within = spec.kind !== 'comp' && isWithinPercentLimit({ amount: entry.amount, base: entry.baseBefore, limitPercent: limit });
  return { amount: entry.amount, effectivePercent: percent, status: within ? 'active' : 'pending_approval' };
}

function shapeResult(row, outlet, evaluation) {
  return {
    discount: row,
    amount: evaluation.amount,
    approvalRequired: row.status === 'pending_approval',
    approvalAction: row.status === 'pending_approval' ? approvalActionFor(outlet) : null,
  };
}

async function insertRequest(trx, { order, outlet, spec, reason, evaluation, userId, extra }) {
  const active = evaluation.status === 'active';
  const [id] = await trx.table('discounts').insert({
    outlet_id: outlet.id,
    pos_order_id: order?.id ?? null,
    scope: spec.scope,
    kind: spec.kind,
    type: spec.type,
    value: spec.value,
    reason_id: reason.id,
    status: evaluation.status,
    effective_percent: evaluation.effectivePercent,
    applied_by_user_id: userId,
    decided_at: active ? new Date() : null,
    // Fixed at the amount the request came to, whether it applies at once or waits for a manager: the manager approves
    // exactly the money the dialog showed, and items added after the request are not discounted (ask again).
    max_amount: evaluation.amount,
    ...extra,
  });
  return trx.table('discounts').where({ id }).first();
}

/**
 * A discount on an open Register tab. `assertTab(order)` is the tab-owner rule (it lives in pos/service.js, which this
 * file must not require) and returns the overridden owner id, or null.
 */
async function createOrderDiscount({ trx, orderId, raw, userId, assertTab }) {
  const spec = { ...readInput(raw), itemId: raw?.item_id ?? raw?.itemId ?? null, menuItemId: null };
  const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
  if (!order) throw new posErrors.OrderNotFoundError();
  if (order.status !== 'open') throw new posErrors.OrderNotOpenError(orderId, order.status);
  const ownerOverride = assertTab ? assertTab(order) : null;
  if (await store.hasCapturedUnsettledPayment(trx, orderId)) throw new errors.DiscountPaymentInProgressError();

  const reason = await loadReasonFor(trx, raw?.reason_id ?? raw?.reasonId, spec.kind);
  // Locking reads, after the order lock: a plain read would keep the snapshot from before it and miss a concurrent change.
  const items = await trx.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at').forShare();
  if (spec.scope === 'line') {
    // The client names any row of the product's line; the discount covers every unvoided row of that product.
    const target = items.find((item) => String(item.id) === String(spec.itemId));
    if (!target) throw new ValidationError('ITEM_NOT_FOUND', 'That line is not on this check.', [{ field: 'item_id', issue: 'not_found' }]);
    spec.menuItemId = target.menu_item_id;
  }
  const live = await trx.table('discounts').where({ pos_order_id: orderId }).whereIn('status', ['active', 'pending_approval']).forShare();
  const taken = live.some((row) => (spec.scope === 'order' ? row.scope === 'order' : row.scope === 'line' && String(row.menu_item_id) === String(spec.menuItemId)));
  if (taken) throw new errors.DiscountAlreadyOnTargetError(spec.scope);

  const evaluation = await evaluate(trx, { items, activeRows: live.filter((row) => row.status === 'active'), spec, userId });
  const outlet = await trx.table('pos_outlets').where({ id: order.outlet_id }).first();
  const row = await insertRequest(trx, {
    order,
    outlet,
    spec,
    reason,
    evaluation,
    userId,
    extra: { menu_item_id: spec.scope === 'line' ? spec.menuItemId : null },
  });
  return { ...shapeResult(row, outlet, evaluation), ownerOverride };
}

/**
 * A discount asked for at the supermarket till BEFORE the sale exists. The server prices the cart it is sent
 * (menu prices, never the client's), so the effective percent and the limit check are the real ones. The row waits,
 * bound to this cashier and outlet, until `createSale` claims it for the sale.
 */
async function createCartDiscount({ trx, outlet, cart, raw, userId }) {
  const spec = { ...readInput(raw), menuItemId: raw?.menu_item_id ?? raw?.menuItemId ?? null };
  if (!Array.isArray(cart) || cart.length === 0 || cart.length > MAX_CART_LINES) {
    throw new ValidationError('MISSING_FIELD', 'The cart is needed to price a discount.', [{ field: 'items', issue: 'missing' }]);
  }
  const reason = await loadReasonFor(trx, raw?.reason_id ?? raw?.reasonId, spec.kind);

  const items = [];
  for (const [index, line] of cart.entries()) {
    const menuItem = await outletMenu.menuItemAtOutlet(trx, outlet.id, line?.menu_item_id);
    const quantity = Number(line?.quantity);
    if (!menuItem || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new ValidationError('INVALID_CART', `Line ${index + 1} cannot be priced.`, [{ field: `items[${index}]`, issue: 'invalid' }]);
    }
    items.push({ id: index + 1, menu_item_id: menuItem.id, unit_price: menuItem.price, quantity, split_group: null, modifiers: [] });
  }
  if (spec.scope === 'line') {
    if (!items.some((item) => String(item.menu_item_id) === String(spec.menuItemId))) {
      throw new ValidationError('ITEM_NOT_FOUND', 'That product is not in the cart.', [{ field: 'menu_item_id', issue: 'not_found' }]);
    }
  }
  const evaluation = await evaluate(trx, { items, activeRows: [], spec, userId });
  const row = await insertRequest(trx, {
    order: null,
    outlet,
    spec,
    reason,
    evaluation,
    userId,
    extra: { menu_item_id: spec.scope === 'line' ? spec.menuItemId : null, expires_at: new Date(Date.now() + CART_GRANT_TTL_MS) },
  });
  return shapeResult(row, outlet, evaluation);
}

// ---------------------------------------------------------------- approval and removal

/** Locks the discount's order first (the order every path locks in), then the discount itself. */
async function lockDiscount(trx, discountId) {
  const peek = await trx.table('discounts').where({ id: discountId }).first();
  if (!peek) throw new errors.DiscountNotFoundError();
  const order = peek.pos_order_id ? await trx.table('pos_orders').where({ id: peek.pos_order_id }).forUpdate().first() : null;
  const row = await trx.table('discounts').where({ id: discountId }).forUpdate().first();
  return { row, order };
}

/**
 * Activates a pending discount. The manager's approval (already claimed in this same transaction, so a refusal here
 * rolls the claim back) must come from someone whose own limit covers it, and a comp from someone who holds
 * `discount.comp`.
 */
async function approveDiscount({ trx, discountId, approverUserId, approvalId }) {
  const { row, order } = await lockDiscount(trx, discountId);
  if (row.status !== 'pending_approval') throw new errors.DiscountStateError(row.id, row.status);
  if (row.expires_at && new Date(row.expires_at) <= new Date()) throw new errors.DiscountGrantInvalidError('This request has expired. Ask for the discount again.');
  if (order) {
    if (order.status !== 'open') throw new posErrors.OrderNotOpenError(order.id, order.status);
    if (await store.hasCapturedUnsettledPayment(trx, order.id)) throw new errors.DiscountPaymentInProgressError();
  }

  const role = await roleAtProperty(trx, trx.context, approverUserId, trx.context.propertyId);
  if (!role || !(await hasPermission(trx, role, 'discount.approve'))) throw new errors.DiscountApproverNotEligibleError('That person cannot approve discounts here.');
  if (row.kind === 'comp') {
    if (!(await hasPermission(trx, role, 'discount.comp'))) throw new errors.DiscountApproverNotEligibleError('That person cannot approve a comp.');
  } else {
    const limit = await store.limitPercentFor(trx, role);
    if (!isWithinPercentLimit({ amount: String(row.effective_percent ?? '0'), base: '100.00', limitPercent: limit })) {
      throw new errors.DiscountApproverNotEligibleError(`That discount is above what that person may approve (${limit}%).`);
    }
  }

  const changed = await trx
    .table('discounts')
    .where({ id: discountId, status: 'pending_approval' })
    .update({ status: 'active', approved_by_user_id: approverUserId, approval_id: approvalId, decided_at: new Date() });
  if (changed !== 1) throw new errors.DiscountStateError(row.id, 'decided');
  return { before: row, after: await trx.table('discounts').where({ id: discountId }).first() };
}

/** Takes a pending or active discount off before the check settles. The row stays, as `removed`, for the audit trail. */
async function removeDiscount({ trx, discountId, userId, reason, assertTab }) {
  const { row, order } = await lockDiscount(trx, discountId);
  if (!['pending_approval', 'active'].includes(row.status)) throw new errors.DiscountStateError(row.id, row.status);
  let ownerOverride = null;
  if (order) {
    if (order.status !== 'open') throw new posErrors.OrderNotOpenError(order.id, order.status);
    ownerOverride = assertTab ? assertTab(order) : null;
    if (await store.hasCapturedUnsettledPayment(trx, order.id)) throw new errors.DiscountPaymentInProgressError();
  } else if (String(row.applied_by_user_id) !== String(userId)) {
    throw new errors.DiscountGrantInvalidError('Only the person who asked for this discount can remove it.');
  }
  const changed = await trx
    .table('discounts')
    .where({ id: discountId })
    .whereIn('status', ['pending_approval', 'active'])
    .update({ status: 'removed', removed_by_user_id: userId, removed_at: new Date() });
  if (changed !== 1) throw new errors.DiscountStateError(row.id, 'decided');
  // A voucher taken off before the check settled frees its attachment (no use was ever counted).
  if (row.kind === 'voucher') await voucherStore.releaseForDiscount(trx, row.id);
  return { before: row, after: await trx.table('discounts').where({ id: discountId }).first(), reason, ownerOverride };
}

/** A discount in the shape the screens read, with its reason's name. */
async function describe(db, rows, amounts = new Map()) {
  const names = await store.reasonNamesFor(db, rows);
  const codes = await voucherStore.codesForDiscounts(db, rows.filter((row) => row.kind === 'voucher').map((row) => row.id));
  return rows.map((row) => ({
    ...(codes.has(String(row.id)) ? { voucher_code: formatVoucherCode(codes.get(String(row.id))) } : {}),
    id: String(row.id),
    scope: row.scope,
    kind: row.kind,
    type: row.type,
    value: String(row.value),
    status: row.status,
    pos_order_item_id: row.pos_order_item_id ? String(row.pos_order_item_id) : null,
    menu_item_id: row.menu_item_id ? String(row.menu_item_id) : null,
    reason_id: String(row.reason_id),
    reason_name: names.get(String(row.reason_id)) ?? '',
    effective_percent: row.effective_percent === null ? null : String(row.effective_percent),
    applied_by_user_id: String(row.applied_by_user_id),
    approved_by_user_id: row.approved_by_user_id ? String(row.approved_by_user_id) : null,
    amount: amounts.get(String(row.id)) ?? (row.status === 'pending_approval' && row.max_amount !== null && row.max_amount !== undefined ? String(row.max_amount) : null),
  }));
}

/** An order's discounts that are still live (pending or active), the active ones with their current amount. */
async function listOrderDiscounts({ db, orderId }) {
  const rows = await db.table('discounts').where({ pos_order_id: orderId }).whereIn('status', ['pending_approval', 'active']).orderBy('id', 'asc');
  const items = await db.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at');
  const active = rows.filter((row) => row.status === 'active');
  const pricing = active.length ? applyDiscounts({ items, discounts: active }) : null;
  const amounts = new Map((pricing?.discounts ?? []).map((entry) => [String(entry.discountId), entry.amount]));
  return describe(db, rows, amounts);
}

/** One discount, for the approval screen. */
async function getDiscount({ db, discountId }) {
  const row = await db.table('discounts').where({ id: discountId }).first();
  if (!row) throw new errors.DiscountNotFoundError();
  const outlet = await db.table('pos_outlets').where({ id: row.outlet_id }).first();
  return { discount: (await describe(db, [row]))[0], approvalAction: approvalActionFor(outlet) };
}

/**
 * The cart-bound discounts a sale names, checked: each must be the caller's own, at this outlet, active (approved, or
 * within limit), unexpired and not claimed by a sale before. Returns the rows; throws otherwise.
 */
async function loadCartGrants({ trx, grantIds, userId, outletId, lock = false }) {
  const ids = [...new Set((grantIds ?? []).map(String))];
  if (ids.length === 0) return [];
  if (ids.length > MAX_CART_LINES) throw new errors.DiscountGrantInvalidError();
  let query = trx
    .table('discounts')
    .whereIn('id', ids)
    .where({ outlet_id: outletId, applied_by_user_id: userId, status: 'active' })
    .whereNull('pos_order_id')
    .where('expires_at', '>', new Date());
  if (lock) query = query.forUpdate();
  const rows = await query;
  if (rows.length !== ids.length) throw new errors.DiscountGrantInvalidError('A discount on this sale is not approved, has expired, or was already used. Ask for it again.');
  if (rows.filter((row) => row.scope === 'order').length > 1) throw new errors.DiscountAlreadyOnTargetError('order');
  return rows;
}

/** Lines of a cart as pricing items (ids 1..n); the grants already name their product, so they price as they are. */
function cartPricingInput(cartLines, grantRows) {
  const items = cartLines.map((line, index) => ({ id: index + 1, menu_item_id: line.menu_item_id, unit_price: line.unit_price, quantity: line.quantity, split_group: null, modifiers: [] }));
  return { items, discounts: grantRows };
}

/** What a cart costs with these grants, before any order exists (the online sale prices its intent this way). */
async function priceCartWithGrants({ trx, cartLines, grantIds, userId, outletId }) {
  const grantRows = await loadCartGrants({ trx, grantIds, userId, outletId });
  if (grantRows.length === 0) return null;
  // A voucher would need a hold at checkout start and a release on cancel/expiry: not offered on the online (Paystack) path.
  if (grantRows.some((row) => row.kind === 'voucher')) throw new errors.VoucherNotOnCardError();
  const { items, discounts } = cartPricingInput(cartLines, grantRows);
  return applyDiscounts({ items, discounts });
}

/**
 * Attaches a supermarket sale's discounts to the sale being rung. The conditional update means a second sale, a
 * double click or a retry can never use the same one twice.
 */
async function claimCartDiscounts({ trx, grantIds, userId, outletId, orderId, itemRows }) {
  const rows = await loadCartGrants({ trx, grantIds, userId, outletId, lock: true });
  for (const row of rows) {
    if (row.scope === 'line' && !itemRows.some((item) => String(item.menu_item_id) === String(row.menu_item_id))) {
      throw new errors.DiscountGrantInvalidError('A discounted product is not in this sale.');
    }
    const changed = await trx.table('discounts').where({ id: row.id, status: 'active' }).whereNull('pos_order_id').update({ pos_order_id: orderId });
    if (changed !== 1) throw new errors.DiscountGrantInvalidError();
  }
  return rows;
}

module.exports = {
  KINDS,
  approvalActionFor,
  listReasons,
  createReason,
  updateReason,
  listLimits,
  setLimit,
  createOrderDiscount,
  createCartDiscount,
  approveDiscount,
  removeDiscount,
  listOrderDiscounts,
  getDiscount,
  claimCartDiscounts,
  priceCartWithGrants,
  describe,
};
