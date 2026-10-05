'use strict';

/**
 * POS module service — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md
 * §3.4): outlets, terminals, menu, order flow, cash-up, charge-to-room. QR
 * self-ordering and inventory/stock control are explicitly deferred to
 * Phase 6 (see this module's own `index.js` header) — nothing here
 * anticipates either.
 *
 * ── MONEY: SNAPSHOT AT ADD-TIME, TAX AT SETTLE-TIME ──────────────────────
 *
 * `pos_order_items.unit_price`/`modifiers` are snapshotted from the menu
 * item the moment it's added to a tab — the same `reservation_daily_rates`
 * convention this codebase already uses, so a later menu price change
 * never alters an already-open tab. Tax is resolved at SETTLE time, not
 * add time, per ARCHITECTURE.md §12 ("calculated against the version
 * effective on the charge's business_date") — a tab can sit open across a
 * tax-rate change; what matters is the rate in effect when it's paid.
 *
 * ── SETTLEMENT REUSES CASHIERING'S TAX ENGINE AND `postCharge`, UNCHANGED ─
 *
 * A `room_charge` settlement calls `cashieringService.postCharge({type:
 * 'pos_charge', ...})` directly — that function already accepts
 * `'pos_charge'` (confirmed by reading it), computes tax via the exact
 * same `taxes`/`applies_to` mechanism, and posts both the charge and its
 * tax lines to the folio. Zero changes needed in Cashiering. A `cash`/
 * `card` settlement has no folio to post to, so this module calls the
 * same pure `resolveApplicableTaxVersions`/`computeChargeWithTax`
 * directly, storing the result on `pos_order_settlements` itself instead.
 *
 * ── CONCURRENCY: "POS tab edit" (ARCHITECTURE.md §5) ─────────────────────
 *
 * Every mutation against an open tab (add item, void item, void order,
 * settle) takes a `SELECT ... FOR UPDATE` row lock on the `pos_orders` row
 * first, inside one transaction — the row-lock option ARCHITECTURE.md
 * names for this exact race, the same mechanism already used for the
 * last-room race (`room_type_inventory`) rather than a new optimistic-
 * versioning scheme.
 *
 * ── SPLIT BILLING: ITEM-GROUP, SETTLED ATOMICALLY IN ONE CALL ────────────
 *
 * `pos_order_items.split_group` (nullable int, null = the default single
 * group) tags an item into one of a tab's split groups —
 * `assignItemSplitGroup` moves an item between groups before settlement.
 * `settleOrder` requires the caller to submit exactly one settlement per
 * DISTINCT group actually present among the order's unvoided items in one
 * call — this session's confirmed scope (item-group splits, no drag-and-
 * drop) implemented as "settle the whole tab in one action, however many
 * ways it's split," rather than incremental partial settlements that
 * would need their own separate over/under-settlement bookkeeping.
 */

const { scopedDb } = require('../../db');
const paystackAdapter = require('../cashiering/paystack-adapter');
const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
const { createCategoryCatalogue } = require('../../shared/category-catalogue');
const { sumMoney, negateMoney, compareMoney, percentOfMoney } = require('../../shared/money');
// PLAN.md Phase 6 (QR self-ordering) promoted this out of this module once
// a second caller (`qr-ordering/service.js`) needed the identical
// per-item pricing computation to price a guest's cart before an order
// even exists — re-exported below so no existing import of this module
// breaks.
const { computeItemLineTotal, POS_SERVICE_CHARGE_PERCENT } = require('../../shared/pos-pricing');
const { resolveOrderLine, normalizeModifierCatalogue, modifiersForInsert } = require('../../shared/pos-line-input');
const { outletScopeForUser, scopeCovers, usersCoveringOutlets } = require('../../shared/outlet-assignments');
const { hasPermission } = require('../../auth/rbac');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../cashiering/tax-engine');
const cashieringService = require('../cashiering/service');
const reservationsService = require('../reservations/service');
// PLAN.md Phase 6 (POS inventory & stock control) — a one-way dependency,
// the identical shape this file's own `cashieringService` import already
// establishes: this module calls INTO `stock/service.js`, which never
// requires this file back (see that module's own header).
const stockService = require('../stock/service');
const menuImages = require('./menu-images');
const outletMenu = require('../../shared/outlet-menu');
const { notifyStaff } = require('../notifications/staff-notifications');

/** One settlement row's full charged amount — subtotal, tax, tip, service charge. */
function settlementTotal(settlement) {
  return sumMoney([settlement.subtotal, settlement.tax_amount, settlement.tip_amount, settlement.service_charge]);
}
const {
  OrderNotOpenError,
  OrderItemAlreadyVoidedError,
  RoomChargeRejectedError,
  SettlementGroupsMismatchError,
  ShiftAlreadyOpenError,
  OutletNotFoundError,
  PayoutAccountAlreadyUsedError,
  PayoutAccountRejectedError,
  TerminalNotFoundError,
  MenuItemNotFoundError,
  OrderNotFoundError,
  ShiftAlreadyClosedError,
  ShiftNotFoundError,
  ShiftNotYoursError,
  TabNotYoursError,
  TabNotTransferableError,
  SettlementAlreadyVoidedError,
  RegisterPaymentInvalidError,
  OrderHasCapturedPaymentError,
  SettlementPaidByGatewayError,
  MenuCategoryInUseError,
  StoreOutletNotAPointOfSaleError,
  StoreOutletConversionBlockedError,
} = require('./errors');
const { STORE_OUTLET_TYPE, isPointOfSaleOutlet, isSupermarketOutlet, taxChargeTypeForOutlet } = require('../../shared/outlet-types');

// ---------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------

async function listOutlets({ context }) {
  const db = scopedDb().for(context);
  return db.table('pos_outlets').where({ status: 'active' }).orderBy('code');
}

async function getOutlet({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_outlets').where({ id }).first();
}

async function createOutlet({ context, code, name, type }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping('pos_outlets', `An outlet with code "${code}" already exists at this property.`, async () => {
    const [id] = await db.table('pos_outlets').insert({ code, name, type });
    return getOutlet({ context, id });
  });
}

async function updateOutlet({ context, id, changes }) {
  const db = scopedDb().for(context);
  if (changes.type !== STORE_OUTLET_TYPE) {
    await db.table('pos_outlets').where({ id }).update(changes);
    return getOutlet({ context, id });
  }
  // Becoming a store: refused while the outlet is still selling. The outlet
  // row is locked so two edits can't interleave; an order opened in the
  // instant between this check and the commit is not blocked (`openOrder`
  // takes no outlet lock — making every ordinary tab wait on one to guard a
  // rare admin edit is not worth it). Such a tab stays settleable.
  return db.transaction(async (trx) => {
    const before = await trx.table('pos_outlets').where({ id }).forUpdate().first();
    if (!before) return null;
    if (before.type !== STORE_OUTLET_TYPE) {
      const openOrderCount = await trx.table('pos_orders').where({ outlet_id: id, status: 'open' }).count();
      const activeTokenCount = await trx.table('pos_order_tokens').where({ outlet_id: id, active: true }).count();
      const guestOrderingEnabled = Boolean(before.guest_ordering_enabled);
      if (openOrderCount > 0 || activeTokenCount > 0 || guestOrderingEnabled) {
        throw new StoreOutletConversionBlockedError({ openOrderCount, guestOrderingEnabled, activeTokenCount });
      }
    }
    await trx.table('pos_outlets').where({ id }).update(changes);
    return trx.table('pos_outlets').where({ id }).first();
  });
}

// ---------------------------------------------------------------------
// Outlet terminal accounts — RECORDING ONLY (no money routing). See
// migration 20261116090000 for the full reasoning.
// ---------------------------------------------------------------------

/**
 * Providers that can hold an outlet account. `other` covers any terminal not
 * listed; with no provider name of its own, its account is identified by its
 * label, which is therefore required (the bank is free text, never validated).
 */
const ACCOUNT_PROVIDERS = ['moniepoint', 'opay', 'gtbank', 'other'];

function lastFour(accountNumber) {
  return String(accountNumber).replace(/\s+/g, '').slice(-4);
}

function withLastFour(row) {
  return row ? { ...row, account_number_last4: lastFour(row.account_number) } : row;
}

/** Optional provider: absent/blank is allowed (an account need not belong to a listed provider). */
function normalizeAccountProvider(provider) {
  if (provider === undefined || provider === null || (typeof provider === 'string' && !provider.trim())) return null;
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!ACCOUNT_PROVIDERS.includes(normalized)) {
    throw new ValidationError('INVALID_TERMINAL_PROVIDER', `"provider" must be one of: ${ACCOUNT_PROVIDERS.join(', ')}.`, [{ field: 'provider', issue: 'invalid' }]);
  }
  return normalized;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`INVALID_${field.toUpperCase()}`, `"${field}" must be text.`, [{ field, issue: 'invalid' }]);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`INVALID_${field.toUpperCase()}`, `"${field}" must be at most ${max} characters.`, [{ field, issue: 'too_long' }]);
  return trimmed || null;
}

/** What a sale (and every list) calls an account: "<bank> · <label>", either part optional. Display only, never parsed back. */
function accountDisplayName(row) {
  return [row.bank_name, row.account_label].filter(Boolean).join(' · ') || null;
}

/** Validates a create body, or a full replacement of an account's editable fields. */
function normalizeAccountInput({ provider, accountNumber, accountLabel, bankName }) {
  const normalizedProvider = normalizeAccountProvider(provider);
  const raw = typeof accountNumber === 'string' ? accountNumber.trim() : '';
  const number = raw.replace(/\s+/g, '');
  if (!/^[0-9]{4,40}$/.test(number)) {
    throw new ValidationError('INVALID_ACCOUNT_NUMBER', '"account_number" must be digits only (at least 4).', [{ field: 'account_number', issue: 'invalid' }]);
  }
  const label = optionalText(accountLabel, 'account_label', 80);
  const bank = optionalText(bankName, 'bank_name', 80);
  // An account must be identifiable on a report: a listed provider, a bank, or a label.
  if ((!normalizedProvider || normalizedProvider === 'other') && !label && !bank) {
    throw new ValidationError('MISSING_ACCOUNT_LABEL', 'Name this account: give a bank or a label (or pick a listed provider).', [{ field: 'account_label', issue: 'missing' }]);
  }
  return { provider: normalizedProvider, account_number: number, account_label: label, bank_name: bank };
}

async function listOutletTerminalAccounts({ context, outletId }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first('id');
  if (!outlet) throw new OutletNotFoundError();
  const rows = await db.table('pos_outlet_terminal_accounts').where({ outlet_id: outletId }).orderBy('id');
  return rows.map(withLastFour);
}

/**
 * What the Register may show an operator: id, name and last 4 ONLY — never the
 * full number. Outlet scope is enforced by the route middleware.
 */
async function listOutletTerminalAccountOptions({ context, outletId }) {
  const db = scopedDb().for(context);
  const rows = await db.table('pos_outlet_terminal_accounts').where({ outlet_id: outletId }).orderBy('id');
  return rows.map((row) => ({ id: row.id, name: accountDisplayName(row), provider: row.provider, last4: lastFour(row.account_number) }));
}

async function createOutletTerminalAccount({ context, outletId, input }) {
  const db = scopedDb().for(context);
  const values = normalizeAccountInput(input);
  return db.transaction(async (trx) => {
    const outlet = await trx.table('pos_outlets').where({ id: outletId }).forUpdate().first();
    if (!outlet || outlet.status !== 'active') throw new OutletNotFoundError();
    const id = await withDuplicateMapping('pos_outlet_terminal_accounts', 'This account number is already recorded for this outlet.', async () => {
      const [insertedId] = await trx.table('pos_outlet_terminal_accounts').insert({ outlet_id: outletId, ...values });
      return insertedId;
    });
    return withLastFour(await trx.table('pos_outlet_terminal_accounts').where({ id }).first());
  });
}

async function updateOutletTerminalAccount({ context, outletId, accountId, input }) {
  const db = scopedDb().for(context);
  const values = normalizeAccountInput(input);
  return db.transaction(async (trx) => {
    const existing = await trx.table('pos_outlet_terminal_accounts').where({ id: accountId, outlet_id: outletId }).forUpdate().first();
    if (!existing) return null;
    await withDuplicateMapping('pos_outlet_terminal_accounts', 'This account number is already recorded for this outlet.', async () => {
      await trx.table('pos_outlet_terminal_accounts').where({ id: existing.id }).update(values);
    });
    return { before: withLastFour(existing), after: withLastFour(await trx.table('pos_outlet_terminal_accounts').where({ id: existing.id }).first()) };
  });
}

/** Removing an account never touches past sales: their snapshot has no foreign key to this row. */
async function removeOutletTerminalAccount({ context, outletId, accountId }) {
  const db = scopedDb().for(context);
  const existing = await db.table('pos_outlet_terminal_accounts').where({ id: accountId, outlet_id: outletId }).first();
  if (!existing) return null;
  await db.table('pos_outlet_terminal_accounts').where({ id: existing.id }).delete();
  return withLastFour(existing);
}

// ---------------------------------------------------------------------
// Outlet payout accounts — the Paystack subaccount an outlet's ONLINE card
// payments (QR orders, Register card/NQR) settle to. See migration
// 20261118090000. An outlet with none uses the property's account.
// ---------------------------------------------------------------------

const PAYOUT_PERCENTAGE_CHARGE = '0.00';

function publicPayoutAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    outlet_id: row.outlet_id,
    bank_code: row.bank_code,
    bank_name: row.bank_name,
    account_number_last4: row.account_number_last4,
    account_name: row.account_name,
    percentage_charge: row.percentage_charge,
    created_at: row.created_at,
  };
}

function requirePayoutBankFields({ bankCode, bankName, accountNumber }) {
  const missing = [];
  if (!bankCode) missing.push({ field: 'bank_code', issue: 'missing' });
  if (!bankName) missing.push({ field: 'bank_name', issue: 'missing' });
  if (!accountNumber) missing.push({ field: 'account_number', issue: 'missing' });
  if (missing.length) throw new ValidationError('MISSING_FIELD', '"bank_code", "bank_name" and "account_number" are required.', missing);
  if (!/^[0-9]{6,20}$/.test(String(accountNumber).replace(/\s+/g, ''))) {
    throw new ValidationError('INVALID_ACCOUNT_NUMBER', '"account_number" must be digits only.', [{ field: 'account_number', issue: 'invalid' }]);
  }
}

async function getPayableOutlet(db, outletId) {
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet || outlet.status !== 'active') throw new OutletNotFoundError();
  return outlet;
}

/** The outlet's own account (if any) and where its online payments actually go right now. */
async function getOutletPayoutAccount({ context, outletId }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  const own = await db.table('pos_outlet_payment_subaccounts').where({ outlet_id: outletId, is_active: true }).first();
  const property = own ? null : await db.table('property_payment_subaccounts').where({ property_id: context.propertyId, is_active: true }).first();
  const settlesTo = own
    ? { source: 'outlet', bank_name: own.bank_name, account_number_last4: own.account_number_last4, account_name: own.account_name }
    : property
      ? { source: 'property', bank_name: property.bank_name, account_number_last4: property.account_number_last4, account_name: property.account_name }
      : { source: null };
  return { account: publicPayoutAccount(own), settles_to: settlesTo };
}

/**
 * "Verify with Paystack": asks Paystack about the subaccount online payments at
 * this outlet settle to RIGHT NOW (the outlet's own, else the property's) and
 * compares it with what we stored. Read-only; a Paystack outage is a 502, not a
 * verdict. `problems` is empty only when Paystack reports it active (and, where
 * it says so, verified), on the same bank account ending and the same split.
 * The subaccount code itself is never returned.
 */
async function verifyOutletPayoutAccount({ context, outletId }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  const own = await db.table('pos_outlet_payment_subaccounts').where({ outlet_id: outletId, is_active: true }).first();
  const row = own ?? (await db.table('property_payment_subaccounts').where({ property_id: context.propertyId, is_active: true }).first());
  if (!row) throw new ValidationError('NO_PAYOUT_ACCOUNT', 'No payout account is configured for this outlet or the property, so there is nothing to verify.', [{ field: 'outlet_id', issue: 'no_payout_account' }]);
  const property = await db.table('properties').where({ id: context.propertyId }).first('base_currency');
  const { adapter } = await paystackAdapter.resolveAdapterForCurrency(db, property.base_currency);
  const remote = await adapter.fetchSubaccount({ subaccountCode: row.subaccount_code });

  const problems = [];
  if (remote.active === false) problems.push('Paystack reports this subaccount is not active.');
  if (remote.isVerified === false) problems.push('Paystack reports this subaccount is not verified, so payouts may not land.');
  const remoteLast4 = remote.accountNumber ? remote.accountNumber.slice(-4) : null;
  if (remoteLast4 && remoteLast4 !== row.account_number_last4) problems.push(`Paystack holds a different bank account (ending ${remoteLast4}) than the one recorded here (ending ${row.account_number_last4}).`);
  if (remote.percentageCharge != null && Number(remote.percentageCharge) !== Number(row.percentage_charge)) problems.push(`Paystack's platform fee for it is ${remote.percentageCharge}%, not the ${row.percentage_charge}% recorded here.`);
  return {
    source: own ? 'outlet' : 'property',
    ok: problems.length === 0,
    problems,
    local: { bank_name: row.bank_name, account_name: row.account_name, account_number_last4: row.account_number_last4, percentage_charge: row.percentage_charge },
    paystack: { active: remote.active, verified: remote.isVerified, business_name: remote.businessName, settlement_bank: remote.settlementBank, account_number_last4: remoteLast4, percentage_charge: remote.percentageCharge },
  };
}

async function resolveOutletPayoutBankAccount({ context, outletId, bankCode, accountNumber }) {
  if (!bankCode || !accountNumber) throw new ValidationError('MISSING_FIELD', 'Both "bank_code" and "account_number" are required.', [{ field: !bankCode ? 'bank_code' : 'account_number', issue: 'missing' }]);
  const db = scopedDb().for(context);
  await getPayableOutlet(db, outletId);
  const property = await db.table('properties').where({ id: context.propertyId }).first();
  const { adapter } = await paystackAdapter.resolveAdapterForCurrency(db, property.base_currency);
  return adapter.resolveBankAccount({ bankCode, accountNumber });
}

/**
 * Creates a Paystack subaccount named "<Property> — <Outlet>" and makes it the
 * outlet's active account. The previous active row (if any) is deactivated, not
 * updated, so payments already routed through it keep resolving. The external
 * call runs OUTSIDE any transaction. If Paystack refuses because the account
 * number is already attached to another subaccount, that is reported and the
 * admin resolves it — an existing subaccount is never reused by guessing.
 */
async function setOutletPayoutAccount({ context, outletId, bankCode, bankName, accountNumber }) {
  requirePayoutBankFields({ bankCode, bankName, accountNumber });
  const number = String(accountNumber).replace(/\s+/g, '');
  const db = scopedDb().for(context);
  const outlet = await getPayableOutlet(db, outletId);
  if (!isPointOfSaleOutlet(outlet)) throw new StoreOutletNotAPointOfSaleError(outlet.name);
  const property = await db.table('properties').where({ id: context.propertyId }).first();
  const { integration, adapter } = await paystackAdapter.resolveAdapterForCurrency(db, property.base_currency);

  let created;
  try {
    created = await adapter.createSubaccount({
      businessName: `${property.name} — ${outlet.name}`,
      bankCode,
      accountNumber: number,
      percentageCharge: PAYOUT_PERCENTAGE_CHARGE,
    });
  } catch (error) {
    if (error?.code === 'PAYMENT_GATEWAY_ERROR' && error.details?.httpStatus && error.details.httpStatus < 500) {
      const message = String(error.details?.body?.message ?? '');
      if (/already|exist|duplicate|in use/i.test(message)) throw new PayoutAccountAlreadyUsedError();
      throw new PayoutAccountRejectedError(message || 'the account details were not accepted.');
    }
    throw error;
  }

  const result = await db.transaction(async (trx) => {
    await trx.table('pos_outlets').where({ id: outletId }).forUpdate().first('id');
    const previous = await trx.table('pos_outlet_payment_subaccounts').where({ outlet_id: outletId, is_active: true }).first();
    if (previous) await trx.table('pos_outlet_payment_subaccounts').where({ id: previous.id }).update({ is_active: false });
    const [id] = await trx.table('pos_outlet_payment_subaccounts').insert({
      outlet_id: outletId,
      platform_payment_integration_id: integration.id,
      subaccount_code: created.subaccountCode,
      bank_code: bankCode,
      bank_name: bankName,
      account_number_last4: number.slice(-4),
      account_name: created.accountName,
      percentage_charge: PAYOUT_PERCENTAGE_CHARGE,
      is_active: true,
    });
    return { previous: publicPayoutAccount(previous), current: publicPayoutAccount(await trx.table('pos_outlet_payment_subaccounts').where({ id }).first()) };
  });
  return result;
}

/** Deactivates the outlet's account; its online payments go back to the property's. Past payments keep their snapshot. */
async function clearOutletPayoutAccount({ context, outletId }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const outlet = await trx.table('pos_outlets').where({ id: outletId }).forUpdate().first();
    if (!outlet) throw new OutletNotFoundError();
    const existing = await trx.table('pos_outlet_payment_subaccounts').where({ outlet_id: outletId, is_active: true }).first();
    if (!existing) return null;
    await trx.table('pos_outlet_payment_subaccounts').where({ id: existing.id }).update({ is_active: false });
    return publicPayoutAccount(existing);
  });
}

async function archiveOutlet({ context, id }) {
  return updateOutlet({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------

/** `outletIds` (optional, from staff outlet assignments) limits the list to those outlets. */
async function listTerminals({ context, outletId, outletIds = null }) {
  const db = scopedDb().for(context);
  let query = db.table('pos_terminals').where({ status: 'active' });
  if (outletId) query = query.where({ outlet_id: outletId });
  if (outletIds) query = query.whereIn('outlet_id', outletIds);
  return query.orderBy('device_ref');
}

async function getTerminal({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_terminals').where({ id }).first();
}

async function createTerminal({ context, outletId, deviceRef, supportsContactless }) {
  const db = scopedDb().for(context);
  const outlet = await getOutlet({ context, id: outletId });
  if (!outlet) throw new OutletNotFoundError();
  if (!isPointOfSaleOutlet(outlet)) throw new StoreOutletNotAPointOfSaleError(outlet.name);
  return withDuplicateMapping('pos_terminals', `A terminal with device ref "${deviceRef}" already exists at this outlet.`, async () => {
    const [id] = await db.table('pos_terminals').insert({ outlet_id: outletId, device_ref: deviceRef, supports_contactless: !!supportsContactless });
    return getTerminal({ context, id });
  });
}

async function updateTerminal({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('pos_terminals').where({ id }).update(changes);
  return getTerminal({ context, id });
}

async function archiveTerminal({ context, id }) {
  return updateTerminal({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// The shared catalogue — user-requested (migration
// 20261108090000_shared_pos_catalogue): categories and menu items belong
// to the PROPERTY; each outlet carries some categories and sells every
// active item in them. `pos_menu_items.category` holds the category name.
// What an outlet sells, and at what price, is `shared/outlet-menu.js`.
// ---------------------------------------------------------------------

const menuCategoryCatalogue = createCategoryCatalogue({
  table: 'pos_menu_categories',
  resolveMode: 'name',
  optional: false,
  cascadeRename: { table: 'pos_menu_items', matchColumn: 'category' },
  // The Setup and Stock category lists hold the same names (user-requested);
  // stock's config mirrors the other way.
  mirror: { table: 'stock_item_categories', cascadeRename: { table: 'stock_items', matchColumn: 'category' } },
  inUseChecks: [{ table: 'pos_menu_items', matchColumn: 'category', matchBy: 'name', filter: (q) => q.where({ status: 'active' }) }],
  errors: {
    categoryNotFound: () =>
      new ValidationError('CATEGORY_NOT_FOUND', 'Choose a category from the list — register new categories in Menu categories first.', [
        { field: 'category', issue: 'not_registered' },
      ]),
    categoryInUse: (name, itemCount) => new MenuCategoryInUseError(name, itemCount),
  },
});

async function assertActiveOutlets(db, outletIds) {
  for (const outletId of outletIds) {
    const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
    if (!outlet || outlet.status !== 'active') throw new OutletNotFoundError();
  }
}

/**
 * Every category of the property, each with `outlet_ids` (the outlets that
 * carry it). With `outletId`, only the categories that outlet carries.
 */
async function listMenuCategories({ context, db: providedDb, includeArchived, outletId }) {
  const db = providedDb ?? scopedDb().for(context);
  const rows = await menuCategoryCatalogue.listCategories({ context, db, includeArchived });
  const carries = await db.table('pos_outlet_categories').select('outlet_id', 'category_id');
  const outletsByCategory = new Map();
  for (const carry of carries) {
    const key = String(carry.category_id);
    if (!outletsByCategory.has(key)) outletsByCategory.set(key, []);
    outletsByCategory.get(key).push(String(carry.outlet_id));
  }
  const withOutlets = rows.map((row) => ({ ...row, outlet_ids: outletsByCategory.get(String(row.id)) ?? [] }));
  if (!outletId) return withOutlets;
  return withOutlets.filter((row) => row.outlet_ids.includes(String(outletId)));
}
const getMenuCategory = menuCategoryCatalogue.getCategory;

/**
 * Registers a shared category; `outletIds` (optional) are the outlets that should carry it straight away.
 * `db` (optional): a transaction-bound accessor to write through (the supermarket product import's one transaction).
 */
async function createMenuCategory({ context, db: providedDb, name, sortOrder, outletIds = [] }) {
  const db = providedDb ?? scopedDb().for(context);
  const ids = [...new Set((outletIds ?? []).filter((id) => id !== undefined && id !== null && id !== '').map(String))];
  await assertActiveOutlets(db, ids);
  const category = await menuCategoryCatalogue.createCategory({ context, db, name, sortOrder });
  for (const outletId of ids) await outletMenu.carryCategory(db, outletId, category.id);
  return (await listMenuCategories({ context, db, includeArchived: true })).find((row) => String(row.id) === String(category.id));
}
const updateMenuCategory = menuCategoryCatalogue.updateCategory;
const archiveMenuCategory = menuCategoryCatalogue.archiveCategory;
/** The active category matching `name` (case-insensitively) — its canonical spelling is what the menu item stores. */
function resolveMenuCategoryName({ db, name }) {
  return menuCategoryCatalogue.resolveByName({ db, name });
}

/**
 * Replaces the set of categories an outlet carries — "when I create an
 * outlet I can choose any category I want in that outlet" (user-requested).
 * The outlet then sells every active item in them, including items added
 * later. Categories must exist; an archived one it already carries may stay.
 */
async function setOutletCategories({ context, outletId, categoryIds }) {
  const db = scopedDb().for(context);
  if (!Array.isArray(categoryIds)) {
    throw new ValidationError('MISSING_FIELD', '"category_ids" must be a list.', [{ field: 'category_ids', issue: 'invalid' }]);
  }
  const wanted = [...new Set(categoryIds.map(String))];
  return db.transaction(async (trx) => {
    const outlet = await trx.table('pos_outlets').where({ id: outletId }).forUpdate().first();
    if (!outlet || outlet.status !== 'active') throw new OutletNotFoundError();
    const current = new Set(await outletMenu.carriedCategoryIds(trx, outletId));
    for (const categoryId of wanted) {
      if (current.has(categoryId)) continue;
      const category = await trx.table('pos_menu_categories').where({ id: categoryId, status: 'active' }).first('id');
      if (!category) {
        throw new ValidationError('CATEGORY_NOT_FOUND', 'One of the chosen categories does not exist.', [{ field: 'category_ids', issue: 'not_found' }]);
      }
      await outletMenu.carryCategory(trx, outletId, categoryId);
    }
    const removed = [...current].filter((categoryId) => !wanted.includes(categoryId));
    if (removed.length) await trx.table('pos_outlet_categories').where({ outlet_id: outletId }).whereIn('category_id', removed).delete();
    return outletMenu.carriedCategoryIds(trx, outletId);
  });
}

// ---------------------------------------------------------------------
// Menu items — shared; `outletId` narrows a list to what that outlet
// sells, with that outlet's own price and availability applied.
// ---------------------------------------------------------------------

async function listMenuItems({ context, outletId }) {
  const db = scopedDb().for(context);
  if (outletId) return (await outletMenu.menuItemsForOutlet(db, outletId)).map(menuImages.withImageUrl);
  const rows = await db.table('pos_menu_items').where({ status: 'active' }).orderBy('category').orderBy('name');
  return rows.map(menuImages.withImageUrl);
}

async function getMenuItem({ context, db: providedDb, id, outletId }) {
  const db = providedDb ?? scopedDb().for(context);
  if (outletId) return menuImages.withImageUrl(await outletMenu.menuItemAtOutlet(db, outletId, id));
  return menuImages.withImageUrl(await db.table('pos_menu_items').where({ id }).first());
}

/**
 * A shared item. `outletId` (optional) is where it is being added from: that
 * outlet then carries the item's category if it did not already, so the new
 * item shows up there straight away.
 */
async function createMenuItem({ context, db: providedDb, outletId, name, category, price, costPrice, modifiers }) {
  // `db` (optional): a transaction-bound accessor to write through (the supermarket product import's one transaction).
  const db = providedDb ?? scopedDb().for(context);
  if (outletId) await assertActiveOutlets(db, [outletId]);
  const categoryName = await resolveMenuCategoryName({ db, name: category });
  const [id] = await db.table('pos_menu_items').insert({
    name,
    category: categoryName,
    price,
    // Gap closure: a fallback cost for margin reporting, used only when
    // this item has no recipe/BOM (stock/reporting.js's own header). Never
    // read anywhere else in POS core.
    cost_price: costPrice ?? null,
    modifiers: modifiersForInsert(normalizeModifierCatalogue(modifiers ?? null)),
  });
  if (outletId) {
    const categoryRow = await db.table('pos_menu_categories').where({ name: categoryName }).first('id');
    if (categoryRow) await outletMenu.carryCategory(db, outletId, categoryRow.id);
  }
  return getMenuItem({ context, db, id });
}

async function updateMenuItem({ context, id, changes }) {
  const db = scopedDb().for(context);
  const next = { ...changes };
  if (next.modifiers !== undefined) next.modifiers = modifiersForInsert(normalizeModifierCatalogue(next.modifiers));
  if (next.category !== undefined) {
    const current = await db.table('pos_menu_items').where({ id }).first('category');
    const unchanged = current && typeof next.category === 'string' && next.category.trim() === current.category;
    // An item keeps its current category even if that category has since
    // been archived — editing only its price must not be refused. Only a
    // change of category has to name an active registered one.
    if (unchanged) delete next.category;
    else next.category = await resolveMenuCategoryName({ db, name: next.category });
  }
  if (Object.keys(next).length) await db.table('pos_menu_items').where({ id }).update(next);
  return getMenuItem({ context, id });
}

/**
 * Stores a new photo for a menu item, replacing (and deleting) any previous
 * one. The item row is locked first (ARCHITECTURE.md §5), so two uploads
 * for the same item run one after the other and each deletes the file the
 * other actually replaced — no file is ever left on disk unreferenced. If
 * the item does not exist, or the update fails, the just-written file is
 * removed again.
 */
async function setMenuItemImage({ context, id, buffer }) {
  const db = scopedDb().for(context);
  let newFile = null;
  let replacedFile = null;
  try {
    await db.transaction(async (trx) => {
      const existing = await trx.table('pos_menu_items').where({ id }).forUpdate().first();
      if (!existing) throw new MenuItemNotFoundError();
      newFile = menuImages.saveImage(buffer);
      await trx.table('pos_menu_items').where({ id }).update({ image_path: newFile });
      replacedFile = existing.image_path;
    });
  } catch (error) {
    menuImages.deleteImage(newFile);
    throw error;
  }
  menuImages.deleteImage(replacedFile);
  return getMenuItem({ context, id });
}

async function removeMenuItemImage({ context, id }) {
  const db = scopedDb().for(context);
  const removedFile = await db.transaction(async (trx) => {
    const existing = await trx.table('pos_menu_items').where({ id }).forUpdate().first();
    if (!existing) throw new MenuItemNotFoundError();
    await trx.table('pos_menu_items').where({ id }).update({ image_path: null });
    return existing.image_path;
  });
  menuImages.deleteImage(removedFile);
  return getMenuItem({ context, id });
}

/**
 * The stock-out toggle (PRODUCT_REQUIREMENTS.md §3.4) — staff mark an item
 * unavailable AT ONE OUTLET without an admin edit (selling out at the bar
 * must not switch it off at the restaurant). Same `pos.operate` grant as
 * running the register, not `pos.manage` — see routes.js.
 *
 * ALWAYS clears `stock_auto_unavailable` back to `false`, in either
 * direction: an explicit human action always wins over the stock
 * module's own automatic bookkeeping (`stock/service.js`'s
 * `applyStockAvailabilityEffects`).
 */
async function setMenuItemAvailability({ context, id, outletId, isAvailable }) {
  const db = scopedDb().for(context);
  if (!outletId) throw new ValidationError('MISSING_FIELD', '"outlet_id" is required.', [{ field: 'outlet_id', issue: 'missing' }]);
  return db.transaction(async (trx) => {
    const item = await outletMenu.menuItemAtOutlet(trx, outletId, id);
    if (!item) throw new MenuItemNotFoundError();
    await outletMenu.upsertOutletMenuSetting(trx, outletId, id, { is_available: Boolean(isAvailable), stock_auto_unavailable: false });
    return menuImages.withImageUrl(await outletMenu.menuItemAtOutlet(trx, outletId, id));
  });
}

/** One outlet's own price for an item (user-requested); `price: null` goes back to the item's main price. */
async function setOutletMenuItemPrice({ context, id, outletId, price }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const item = await outletMenu.menuItemAtOutlet(trx, outletId, id);
    if (!item) throw new MenuItemNotFoundError();
    await outletMenu.upsertOutletMenuSetting(trx, outletId, id, { price: price ?? null });
    return menuImages.withImageUrl(await outletMenu.menuItemAtOutlet(trx, outletId, id));
  });
}

async function archiveMenuItem({ context, id }) {
  return updateMenuItem({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// In-house guest lookup (charge-to-room) — thin pass-through to
// reservations/service.js, the module that actually owns this concept.
// ---------------------------------------------------------------------

async function findInHouseForCharge({ context, query }) {
  return reservationsService.findInHouseForCharge({ context, query });
}

// ---------------------------------------------------------------------
// Orders (tabs)
// ---------------------------------------------------------------------

/** `outletIds` (optional, from staff outlet assignments) limits the list to those outlets. */
async function listOrders({ context, outletId, status, outletIds = null }) {
  const db = scopedDb().for(context);
  let query = db.table('pos_orders');
  if (outletId) query = query.where({ outlet_id: outletId });
  if (outletIds) query = query.whereIn('outlet_id', outletIds);
  if (status) query = query.where({ status });
  return query.orderBy('opened_at', 'desc');
}

/**
 * The kitchen/bar ticket queue (POS → Tickets): every tab with something to
 * make that the kitchen has not yet marked done, oldest first, with its
 * unvoided items and their menu names — one query for the tabs and one for
 * all their items.
 *
 * Not "open tabs": a tab paid at the point of order (a guest QR card order,
 * the Register's "Send to Bar & Checkout") is settled within seconds, long
 * before anything is made. So a ticket is any non-void tab whose
 * `ticket_done_at` is still empty, paid or not.
 *
 * Guest QR orders appear once paid (`received`, still awaiting acceptance
 * on the Guest orders tab — flagged so) or accepted (`preparing`). An order
 * still awaiting card payment never reaches the kitchen; one already
 * `on_the_way` has left it. Tabs with no items are left out.
 */
const TICKET_GUEST_STATUSES = ['received', 'preparing'];

async function listKitchenTickets({ context, outletId, outletIds = null }) {
  const db = scopedDb().for(context);
  let query = db
    .table('pos_orders')
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'pos_orders.outlet_id'))
    .joinScoped('pos_guest_orders', (join) => join.on('pos_guest_orders.pos_order_id', '=', 'pos_orders.id'), { type: 'left' })
    .whereIn('pos_orders.status', ['open', 'settled'])
    .whereNull('pos_orders.ticket_done_at');
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  if (outletIds) query = query.whereIn('pos_orders.outlet_id', outletIds);
  const orders = await query
    .select(
      'pos_orders.id',
      'pos_orders.outlet_id',
      'pos_outlets.name as outlet_name',
      'pos_orders.table_label',
      'pos_orders.source',
      'pos_orders.status',
      'pos_orders.opened_at',
      'pos_guest_orders.status as guest_status',
      'pos_guest_orders.guest_name'
    )
    .orderBy('pos_orders.opened_at', 'asc')
    .orderBy('pos_orders.id', 'asc');

  const visible = orders.filter((order) => order.source !== 'guest' || TICKET_GUEST_STATUSES.includes(order.guest_status));
  if (visible.length === 0) return [];

  const items = await db
    .table('pos_order_items')
    .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'pos_order_items.menu_item_id'))
    .whereIn(
      'pos_order_items.pos_order_id',
      visible.map((order) => order.id)
    )
    .whereNull('pos_order_items.voided_at')
    .select(
      'pos_order_items.id',
      'pos_order_items.pos_order_id',
      'pos_order_items.quantity',
      'pos_order_items.modifiers',
      'pos_order_items.created_at',
      'pos_menu_items.name',
      'pos_menu_items.category'
    )
    .orderBy('pos_order_items.id', 'asc');

  const itemsByOrder = new Map();
  for (const item of items) {
    const key = String(item.pos_order_id);
    if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
    itemsByOrder.get(key).push({
      id: item.id,
      quantity: item.quantity,
      name: item.name,
      category: item.category,
      modifiers: item.modifiers ?? null,
      added_at: item.created_at,
    });
  }

  return visible
    .map((order) => ({ ...order, guest_status: order.source === 'guest' ? order.guest_status : null, items: itemsByOrder.get(String(order.id)) ?? [] }))
    .filter((order) => order.items.length > 0);
}

/**
 * Marks a tab's ticket done — it leaves the kitchen queue. Conditional
 * UPDATE, so two screens bumping the same ticket record one "done by".
 * Marking an already-done ticket is a harmless no-op. A guest order not yet
 * accepted cannot be marked done: it may still be auto-rejected and
 * refunded, so nothing should be made for it yet.
 */
async function markTicketDone({ context, orderId, userId }) {
  const db = scopedDb().for(context);
  const order = await db.table('pos_orders').where({ id: orderId }).first();
  if (!order) return null;
  if (order.status === 'void') throw new OrderNotOpenError(orderId, order.status);
  if (order.source === 'guest') {
    const guestOrder = await db.table('pos_guest_orders').where({ pos_order_id: orderId }).first('status');
    if (guestOrder && !['preparing', 'on_the_way'].includes(guestOrder.status)) {
      throw new ValidationError('POS_TICKET_GUEST_ORDER_NOT_ACCEPTED', 'Accept this guest order on the Guest orders tab before marking it done.');
    }
  }
  await db.table('pos_orders').where({ id: orderId }).whereNull('ticket_done_at').update({ ticket_done_at: new Date(), ticket_done_by_user_id: userId });
  return db.table('pos_orders').where({ id: orderId }).first();
}

async function getOrder({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_orders').where({ id }).first();
}

async function listOrderItems({ context, orderId }) {
  const db = scopedDb().for(context);
  return db.table('pos_order_items').where({ pos_order_id: orderId }).orderBy('id');
}

async function listOrderSettlements({ context, orderId }) {
  const db = scopedDb().for(context);
  return db.table('pos_order_settlements').where({ pos_order_id: orderId }).orderBy('id');
}

/**
 * `terminalId`/`openedByUserId` are only required for `source: 'staff'`
 * (the default, unchanged behaviour for every existing caller) — PLAN.md
 * Phase 6's QR self-ordering module opens a tab with neither, since a
 * guest scanning a table's QR code has no physical terminal and no staff
 * identity behind them at all (`pos_orders.opened_by_user_id`/
 * `terminal_id` are nullable as of that pass's own migration). The
 * terminal lookup/validation below only runs when a terminalId is
 * actually supplied, so a guest order never needs a fake terminal row to
 * satisfy it.
 */
async function openOrder({ context, outletId, terminalId = null, openedByUserId = null, tableLabel, source = 'staff' }) {
  const db = scopedDb().for(context);
  const outlet = await getOutlet({ context, id: outletId });
  if (!outlet) throw new OutletNotFoundError();
  if (!isPointOfSaleOutlet(outlet)) throw new StoreOutletNotAPointOfSaleError(outlet.name);

  if (terminalId) {
    // Matched in the WHERE clause, not fetched-then-compared in JS — a
    // BIGINT id can come back from MySQL as a string while the caller's own
    // value is a JS number (or vice versa); letting the database compare
    // its own column values avoids that type mismatch entirely.
    const terminal = await db.table('pos_terminals').where({ id: terminalId, outlet_id: outletId }).first();
    if (!terminal) throw new TerminalNotFoundError();
  }

  const [id] = await db.table('pos_orders').insert({
    outlet_id: outletId,
    terminal_id: terminalId,
    opened_by_user_id: openedByUserId,
    table_label: tableLabel ?? null,
    source,
  });
  return getOrder({ context, id });
}

async function addItem({ context, orderId, menuItemId, quantity, modifiers, stockOverrideReason }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

    // Matched in the WHERE clause, not fetched-then-compared in JS — see
    // `openOrder`'s own comment on why.
    // The item as sold at THIS order's outlet — its own price and
    // availability there; an item the outlet does not sell is not found.
    const menuItem = await outletMenu.menuItemAtOutlet(trx, order.outlet_id, menuItemId);
    if (!menuItem) throw new MenuItemNotFoundError();
    if (!menuItem.is_available) {
      throw new ValidationError('POS_ITEM_UNAVAILABLE', `"${menuItem.name}" is currently marked unavailable.`);
    }
    // Quantity and modifier choices are checked against the live item; a
    // modifier's price always comes from the item's own catalogue, never
    // from the request (shared/pos-line-input.js).
    const line = resolveOrderLine({ menuItem, unitPrice: menuItem.price, quantity, modifiers });

    // Gap closure — the stock-out override guard (user-reported: the
    // Register let an item sell at zero stock with no proactive check at
    // all). Add-time enforcement: a recipe-less item costs one cheap,
    // empty lookup; see `stockService.assertStockAvailableOrOverridden`'s
    // own header for the full rule.
    await stockService.assertStockAvailableOrOverridden({
      trx,
      lines: [{ menuItemId, quantity: line.quantity }],
      overrideReason: stockOverrideReason,
      userId: context.userId,
      propertyId: order.property_id,
      outletId: order.outlet_id,
    });

    await trx.table('pos_order_items').insert({
      pos_order_id: orderId,
      menu_item_id: menuItemId,
      quantity: line.quantity,
      unit_price: menuItem.price,
      modifiers: modifiersForInsert(line.modifiers),
    });
    // A new item sends the tab back to the kitchen queue.
    if (order.ticket_done_at) await trx.table('pos_orders').where({ id: orderId }).update({ ticket_done_at: null, ticket_done_by_user_id: null });
    return { order, items: await trx.table('pos_order_items').where({ pos_order_id: orderId }).orderBy('id') };
  });
}

/**
 * Locks the item's PARENT ORDER first, then re-reads the item under that
 * lock, before checking any of its state — the same "lock, then check,
 * then write" ordering `settleOrder`/`voidOrder` already use. Checking
 * `voided_at` on an unlocked read (the first draft of this function did)
 * lets two concurrent void requests for the same item both pass the check
 * before either writes, silently overwriting the audit trail (the original
 * voider/reason) with the second caller's — exactly the "POS tab edit"
 * race this module's own header names, for an item this pass's own
 * comments call "the single most common vector for staff theft."
 */
async function lockOrderAndItem({ trx, orderItemId }) {
  const item = await trx.table('pos_order_items').where({ id: orderItemId }).first();
  if (!item) throw new ValidationError('ORDER_ITEM_NOT_FOUND', 'The specified order item does not exist.');

  const order = await trx.table('pos_orders').where({ id: item.pos_order_id }).forUpdate().first();
  if (order.status !== 'open') throw new OrderNotOpenError(order.id, order.status);

  // Re-read the item under its OWN lock, not a plain SELECT — MySQL's
  // REPEATABLE READ isolation gives a plain read the transaction's
  // consistent snapshot from its FIRST read above (taken before the order
  // lock was even requested), not the latest committed row, so a plain
  // re-read here would still see the pre-void state even after blocking on
  // the order's lock and a concurrent voider committing in between. Only a
  // locking read (`forUpdate`) bypasses the snapshot and returns what was
  // actually just committed — without this, two concurrent voids can both
  // pass this check, exactly the bug this function exists to close.
  const lockedItem = await trx.table('pos_order_items').where({ id: orderItemId }).forUpdate().first();
  if (lockedItem.voided_at) throw new OrderItemAlreadyVoidedError(orderItemId);
  return { order, item: lockedItem };
}

/**
 * Who owns a tab: the operator it was last handed to (`owner_user_id`, set
 * by `transferTabs`), else the one who opened it. NULL for a guest QR
 * order, which has no opener and is never transferred.
 */
function tabOwnerId(order) {
  return order.owner_user_id ?? order.opened_by_user_id ?? null;
}

/**
 * Void and rename belong to a tab's owner (user-requested). Anyone else
 * needs `pos.manage` (`canActForOthers`); a void still records its own
 * reason and voider. A tab with no owner — a guest QR order — is left to
 * any operator at its outlet. The owner can change (a transfer), so the
 * deciding check always runs on the row read under the order lock;
 * `voidOrder`'s earlier check is only an early refusal before Paystack.
 */
function assertCanChangeTab(order, { userId, canActForOthers }) {
  const owner = tabOwnerId(order);
  if (owner == null || canActForOthers) return;
  if (String(owner) !== String(userId)) throw new TabNotYoursError(order.id);
}

const MAX_TABS_PER_TRANSFER = 50;

function invalidTransfer(code, message, field) {
  return new ValidationError(code, message, [{ field, issue: 'invalid' }]);
}

/**
 * Staff who may receive a tab at `outletId`: active, holding a role at this
 * property that grants `pos.operate`, and covering the outlet under staff
 * outlet assignments. Sorted by name.
 */
async function listTransferCandidates({ context, outletId }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first('id');
  if (!outlet) throw new OutletNotFoundError();
  const rows = await db
    .table('user_property_access')
    .joinScoped('users', (join) => join.on('users.id', '=', 'user_property_access.user_id'))
    .where('users.status', 'active')
    .select('users.id', 'users.first_name', 'users.last_name', 'user_property_access.role');
  const operators = [];
  for (const row of rows) {
    if (await hasPermission(db, row.role, 'pos.operate')) operators.push(row);
  }
  const covering = new Set((await usersCoveringOutlets(db, operators.map((row) => row.id), [outlet.id])).map(String));
  return operators
    .filter((row) => covering.has(String(row.id)))
    .map((row) => ({ id: row.id, first_name: row.first_name, last_name: row.last_name, role: row.role }))
    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
}

/**
 * Hands one or more open tabs to another operator (shift handover). All or
 * nothing: every tab is locked (ascending id, the order every tab writer
 * locks in) and checked before any is changed.
 *
 * - The caller must own each tab or hold `pos.manage`, and cover its outlet
 *   (a tab outside their outlets is "not found", as elsewhere).
 * - A guest QR tab has no owner and is refused — it is everyone's already.
 * - The receiver must be active here, able to run the Register
 *   (`pos.operate`), and cover every tab's outlet.
 *
 * Returns each tab before and after, for the audit trail.
 */
async function transferTabs({ context, orderIds, toUserId, userId, canActForOthers = false, reason = null }) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) throw invalidTransfer('TRANSFER_NO_TABS', 'Choose at least one tab to hand over.', 'order_ids');
  if (orderIds.length > MAX_TABS_PER_TRANSFER) throw invalidTransfer('TRANSFER_TOO_MANY_TABS', `Hand over at most ${MAX_TABS_PER_TRANSFER} tabs at once.`, 'order_ids');
  const ids = [...new Set(orderIds.map(String))];
  if (ids.length !== orderIds.length || ids.some((id) => !/^\d+$/.test(id))) throw invalidTransfer('TRANSFER_INVALID_TABS', 'Each tab must be listed once, by id.', 'order_ids');
  if (toUserId === undefined || toUserId === null || !/^\d+$/.test(String(toUserId))) throw invalidTransfer('TRANSFER_RECIPIENT_REQUIRED', 'Choose who to hand the tabs to.', 'to_user_id');

  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const orders = await trx.table('pos_orders').whereIn('id', ids).orderBy('id').forUpdate();
    const callerScope = await outletScopeForUser(trx, userId);
    if (orders.length !== ids.length || orders.some((order) => !scopeCovers(callerScope, [order.outlet_id]))) throw new OrderNotFoundError();

    for (const order of orders) {
      if (order.status !== 'open') throw new OrderNotOpenError(order.id, order.status);
      if (tabOwnerId(order) == null) {
        throw new TabNotTransferableError(order.id);
      }
      assertCanChangeTab(order, { userId, canActForOthers });
    }

    const recipient = await trx
      .table('user_property_access')
      .joinScoped('users', (join) => join.on('users.id', '=', 'user_property_access.user_id'))
      .where('user_property_access.user_id', toUserId)
      .where('users.status', 'active')
      .first('user_property_access.role');
    if (!recipient || !(await hasPermission(trx, recipient.role, 'pos.operate'))) {
      throw invalidTransfer('TRANSFER_RECIPIENT_INVALID', 'That person cannot take tabs here: they need an active account with Register access at this property.', 'to_user_id');
    }
    const recipientScope = await outletScopeForUser(trx, toUserId);
    const uncovered = orders.find((order) => !scopeCovers(recipientScope, [order.outlet_id]));
    if (uncovered) throw invalidTransfer('TRANSFER_RECIPIENT_NOT_AT_OUTLET', `That person is not assigned to the outlet of tab #${uncovered.id}.`, 'to_user_id');

    await trx.table('pos_orders').whereIn('id', ids).update({ owner_user_id: toUserId });
    const after = await trx.table('pos_orders').whereIn('id', ids).orderBy('id');

    // The receiver's bell (user-requested), in the same transaction, so an
    // alert never outlives a transfer that rolled back.
    const giver = await trx.table('users').where({ id: userId }).first('first_name', 'last_name');
    const outletRows = await trx.table('pos_outlets').whereIn('id', [...new Set(orders.map((order) => order.outlet_id))]).select('id', 'name');
    await notifyStaff({
      trx,
      eventType: 'pos.tabs_handed_over',
      alsoUserIds: [toUserId],
      payload: {
        count: after.length,
        tabs: after.map((order) => ({ id: order.id, label: order.table_label || `Tab #${order.id}` })),
        outletNames: outletRows.map((outlet) => outlet.name),
        fromName: [giver?.first_name, giver?.last_name].filter(Boolean).join(' ') || null,
        reason: reason || null,
      },
    });
    return orders.map((before, index) => ({ before, after: after[index] }));
  });
}

async function voidOrderItem({ context, orderItemId, reason, userId, canActForOthers = false }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an order item.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const { order } = await lockOrderAndItem({ trx, orderItemId });
    assertCanChangeTab(order, { userId, canActForOthers });
    await trx.table('pos_order_items').where({ id: orderItemId }).update({
      voided_at: new Date(),
      void_reason: reason,
      voided_by_user_id: userId,
    });
    return trx.table('pos_order_items').where({ id: orderItemId }).first();
  });
}

async function assignItemSplitGroup({ context, orderItemId, splitGroup }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    await lockOrderAndItem({ trx, orderItemId });
    await trx.table('pos_order_items').where({ id: orderItemId }).update({ split_group: splitGroup ?? null });
    return trx.table('pos_order_items').where({ id: orderItemId }).first();
  });
}

/**
 * Renames an open tab — the name cashiers and reports know it by ("Table 4",
 * "Pool bar – John", "Room 205"). Locks the order like every tab mutation;
 * a settled or voided tab keeps the name it closed with.
 */
async function renameOrder({ context, orderId, tableLabel, userId, canActForOthers = false }) {
  const name = typeof tableLabel === 'string' ? tableLabel.trim() : '';
  if (!name || name.length > 60) {
    throw new ValidationError('INVALID_TAB_NAME', 'A tab name is required, up to 60 characters.', [{ field: 'table_label', issue: name ? 'too_long' : 'missing' }]);
  }
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);
    assertCanChangeTab(order, { userId, canActForOthers });
    await trx.table('pos_orders').where({ id: orderId }).update({ table_label: name });
    return trx.table('pos_orders').where({ id: orderId }).first();
  });
}

async function voidOrder({ context, orderId, reason, userId, canActForOthers = false }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an order.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);

  // Refuse someone else's tab before asking Paystack anything.
  const existing = await db.table('pos_orders').where({ id: orderId }).first();
  if (existing) assertCanChangeTab(existing, { userId, canActForOthers });

  // A card/NQR checkout still open on Paystack may already have been paid.
  // Ask Paystack first — outside any transaction (ARCHITECTURE.md §7) — so
  // a tab whose guest just paid is refused below instead of voided with
  // the money left unrecorded.
  for (const payment of await listUnsettledRegisterPayments({ db, orderId })) {
    if (payment.status === 'PENDING') {
      await cashieringService.verifyPayment({ context, paymentId: payment.id, userId });
    }
  }

  return db.transaction(async (trx) => {
    const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);
    assertCanChangeTab(order, { userId, canActForOthers });

    const unsettled = await listUnsettledRegisterPayments({ db: trx, orderId });
    const captured = unsettled.find((p) => p.status === 'CAPTURED');
    if (captured) throw new OrderHasCapturedPaymentError(orderId, captured.id);
    // Unpaid checkouts die with the tab. If the guest somehow completes one
    // later anyway, `applyGatewayResult` still records the capture.
    if (unsettled.length > 0) {
      await trx
        .table('payments')
        .whereIn('id', unsettled.map((p) => p.id))
        .whereIn('status', ['INITIATED', 'PENDING'])
        .update({ status: 'CANCELLED', failure_reason: 'The Register tab was voided before payment.' });
    }

    await trx.table('pos_orders').where({ id: orderId }).update({
      status: 'void',
      closed_at: new Date(),
      voided_at: new Date(),
      void_reason: reason,
      voided_by_user_id: userId,
    });
    return trx.table('pos_orders').where({ id: orderId }).first();
  });
}

// ---------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------

function groupKey(splitGroup) {
  return splitGroup === null || splitGroup === undefined ? 'null' : String(splitGroup);
}

/**
 * Read-only, non-mutating preview of what `settleOrder` will actually
 * charge per split group — found necessary by this session's own "test
 * and review Register" pass: the Register screen's settlement panel had
 * no way to preview the real, tax-inclusive amount before confirming (see
 * `RegisterTab.jsx`'s own header for the live-confirmed discrepancy this
 * closes). Reuses the EXACT same `resolveApplicableTaxVersions`/
 * `computeChargeWithTax` calls `settleOrder` itself calls below — never a
 * second, parallel tax algorithm (ARCHITECTURE.md §12). Tax depends only
 * on the order's own items and business_date, never on settlement method
 * or tip/service charge — `cash`/`card`/`room_charge` all compute it
 * identically (confirmed directly against `settleOrder`'s own two
 * branches) — so this takes no method/tip/service-charge input at all,
 * just the order id, and returns one entry per split group actually
 * present, mirroring the shape `settleOrder` itself expects one
 * settlement per.
 *
 * `subtotal` here is the tax engine's own `netAmount`, not the raw item
 * total — for an EXCLUSIVE tax the two are equal, but for an INCLUSIVE
 * tax `netAmount` is the item total minus the tax portion baked into it
 * (`computeChargeWithTax`'s own header). A caller that renders "Subtotal"
 * from this response and then adds `taxAmount` on top gets the correct
 * grand total either way; recomputing "Subtotal" from the raw items
 * client-side instead would double-count tax the moment a property
 * configures an inclusive one.
 */
async function previewSettlement({ context, orderId }) {
  const db = scopedDb().for(context);
  const order = await db.table('pos_orders').where({ id: orderId }).first();
  if (!order) throw new OrderNotFoundError();
  if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

  const items = await db.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at');
  const property = await db.table('properties').where({ id: order.property_id }).first('current_business_date', 'base_currency');
  const businessDate = property?.current_business_date;
  const allTaxRows = await db.table('taxes');
  const saleOutlet = await db.table('pos_outlets').where({ id: order.outlet_id }).first('type');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate, chargeType: taxChargeTypeForOutlet(saleOutlet) });

  const groupKeys = [...new Set(items.map((item) => groupKey(item.split_group)))];
  const groups = groupKeys.map((key) => {
    const splitGroup = key === 'null' ? null : Number(key);
    const groupItems = items.filter((item) => groupKey(item.split_group) === key);
    const baseAmount = sumMoney(groupItems.map(computeItemLineTotal));
    const { netAmount, taxLines } = computeChargeWithTax({ baseAmount, taxVersions });
    const taxAmount = sumMoney(taxLines.map((t) => t.amount));
    const serviceCharge = percentOfMoney(netAmount, POS_SERVICE_CHARGE_PERCENT);
    return { splitGroup, subtotal: netAmount, taxAmount, serviceCharge, total: sumMoney([netAmount, taxAmount, serviceCharge]) };
  });

  return { orderId: order.id, currency: property?.base_currency, groups };
}

/** Methods `settleOrder` accepts. `terminal` = a card sale taken on the hotel's own physical terminal (no gateway). */
const SETTLEMENT_METHODS = ['cash', 'card', 'terminal', 'room_charge'];
/** Terminal providers the Register offers. Optional on every sale; `other` covers any bank POS not listed. */
const TERMINAL_PROVIDERS = ['moniepoint', 'opay', 'gtbank', 'other'];
const TERMINAL_REFERENCE_MAX = 60;

/** Provider and reference are both OPTIONAL: only checked when given, never required. */
function normalizeTerminalDetails({ provider, reference } = {}) {
  // Only strings (or nothing) are meaningful; anything else is a malformed request, not a blank field.
  for (const [field, value] of [['terminal_provider', provider], ['terminal_reference', reference]]) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new ValidationError(`INVALID_${field.toUpperCase()}`, `"${field}" must be text.`, [{ field, issue: 'invalid' }]);
    }
  }
  const normalizedProvider = typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : null;
  if (normalizedProvider && !TERMINAL_PROVIDERS.includes(normalizedProvider)) {
    throw new ValidationError('INVALID_TERMINAL_PROVIDER', `"terminal_provider" must be one of: ${TERMINAL_PROVIDERS.join(', ')}.`, [{ field: 'terminal_provider', issue: 'invalid' }]);
  }
  const normalizedReference = reference === undefined || reference === null ? '' : String(reference).trim();
  if (normalizedReference.length > TERMINAL_REFERENCE_MAX) {
    throw new ValidationError('INVALID_TERMINAL_REFERENCE', `"terminal_reference" must be at most ${TERMINAL_REFERENCE_MAX} characters.`, [{ field: 'terminal_reference', issue: 'too_long' }]);
  }
  return { terminal_provider: normalizedProvider, terminal_reference: normalizedReference || null };
}

/**
 * `trx`-based — called from `runIdempotentMutation`'s handler (financial
 * mutation, ARCHITECTURE.md §7). Locks the order, verifies the requested
 * settlements exactly partition its unvoided items by split_group — every
 * group covered exactly once, none missing, none requested twice (a
 * duplicate group key would otherwise charge/settle the same items once
 * per settlement entry, since processing iterates the raw request array,
 * not a dedup'd set) — then processes each settlement: `room_charge`
 * re-verifies the in-house reservation and its open folio FRESH (never
 * trusts an earlier search result), posts through `cashieringService.postCharge`,
 * and posts any nonzero tip/service charge as a separate, untaxed
 * `postAdjustment` line on the same folio; `cash`/`card` compute tax
 * directly and record the settlement with no folio involved at all;
 * `terminal` follows the cash path (tax, tip) but is a card taken on the
 * hotel's own physical terminal: nothing to collect or verify, and it is
 * never counted in the drawer's expected cash.
 */
async function settleOrder({ trx, orderId, settledByUserId, settlements, stockOverrideReason, claimPayment }) {
  if (!Array.isArray(settlements) || settlements.length === 0) {
    throw new ValidationError('MISSING_FIELD', 'At least one settlement is required.', [{ field: 'settlements', issue: 'missing' }]);
  }

  const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
  if (!order) throw new OrderNotFoundError();
  if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

  const items = await trx.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at');
  const groupsPresent = new Set(items.map((item) => groupKey(item.split_group)));
  const requestedKeys = settlements.map((s) => groupKey(s.splitGroup));
  const groupsRequested = new Set(requestedKeys);

  // Each group must be requested EXACTLY once: a duplicate key here would
  // charge/settle the same items twice (once per settlement entry) since
  // the processing loop below iterates the raw array, not this dedup'd
  // set — a real double-billing bug an earlier draft of this function had.
  if (requestedKeys.length !== groupsRequested.size) {
    throw new SettlementGroupsMismatchError('duplicate', { present: [...groupsPresent], requested: requestedKeys });
  }
  const sameGroups = groupsPresent.size === groupsRequested.size && [...groupsPresent].every((g) => groupsRequested.has(g));
  if (!sameGroups) {
    throw new SettlementGroupsMismatchError('uncovered', { present: [...groupsPresent], requested: requestedKeys });
  }

  // Gap closure — the stock-out override guard's settle-time, defensive
  // check (add-time already checked this at `addItem`, but stock can
  // change between add and settle). One guard call covers every item
  // across every split-group in this ONE settle-order request — a throw
  // here aborts before any group's settlement row is even inserted, so the
  // whole request is retried with the reason attached, never a partial
  // settle. See `stockService.assertStockAvailableOrOverridden`'s header.
  const stockGuardResult = await stockService.assertStockAvailableOrOverridden({
    trx,
    lines: items.map((item) => ({ menuItemId: item.menu_item_id, quantity: item.quantity })),
    overrideReason: stockOverrideReason,
    userId: settledByUserId,
    propertyId: order.property_id,
    outletId: order.outlet_id,
  });
  const overrideReasonsByStockItemId = stockOverrideReason?.trim()
    ? new Map(stockGuardResult.affectedStockItemIds.map((id) => [id, stockOverrideReason.trim()]))
    : undefined;

  const property = await trx.table('properties').where({ id: order.property_id }).first('current_business_date', 'base_currency');
  const businessDate = property?.current_business_date;
  const allTaxRows = await trx.table('taxes');
  const saleOutlet = await trx.table('pos_outlets').where({ id: order.outlet_id }).first('type');
  const saleTaxChargeType = taxChargeTypeForOutlet(saleOutlet);

  // Cash-up attribution: record which shift was open on this terminal when
  // the sale settled, so `closeShift` counts exactly these rows rather than
  // guessing by timestamp. See `lockTerminalForShifts` for the lock order —
  // a shared terminal lock lets sales on one terminal run side by side while
  // still waiting out an in-flight open/close, and the shift read itself is
  // a locking read so it sees that open/close's committed result rather
  // than this transaction's older snapshot.
  let openShift = null;
  if (order.terminal_id) {
    await lockTerminalForShifts(trx, order.terminal_id, 'share');
    openShift = await trx.table('pos_shifts').where({ terminal_id: order.terminal_id }).whereNull('closed_at').forShare().first('id');
  }

  const results = [];
  for (const settlement of settlements) {
    if (!SETTLEMENT_METHODS.includes(settlement.method)) {
      throw new ValidationError('INVALID_SETTLEMENT_METHOD', `"${settlement.method}" is not a supported settlement method — use "cash", "card", "terminal", or "room_charge".`);
    }

    const groupItems = items.filter((item) => groupKey(item.split_group) === groupKey(settlement.splitGroup));
    const baseAmount = sumMoney(groupItems.map(computeItemLineTotal));
    const tipAmount = settlement.tipAmount ?? '0.00';
    const serviceCharge = settlement.serviceCharge ?? '0.00';

    const fields = {
      pos_order_id: orderId,
      split_group: settlement.splitGroup ?? null,
      method: settlement.method,
      tip_amount: tipAmount,
      service_charge: serviceCharge,
      settled_by_user_id: settledByUserId,
      business_date: businessDate ?? null,
      pos_shift_id: openShift?.id ?? null,
    };

    if (settlement.method === 'room_charge') {
      const roomCharge = settlement.roomCharge ?? {};
      // Bug fix (this session's "test and review Register" pass, live-
      // confirmed): with no reservationId, `where({ id: undefined })` below
      // threw a raw, uncaught mysql2 "undefined binding" exception — not an
      // AppError, so it fell through to a bare 500 instead of telling the
      // cashier what actually went wrong. A cashier can reach this by
      // choosing "Charge to room" and never selecting a guest.
      if (!roomCharge.reservationId) {
        throw new ValidationError(
          'MISSING_FIELD',
          'A guest must be selected before this settlement can be charged to a room.',
          [{ field: 'roomCharge.reservationId', issue: 'missing' }]
        );
      }
      const reservation = await trx.table('reservations').where({ id: roomCharge.reservationId }).first();
      if (!reservation || reservation.status !== 'checked_in') {
        throw new RoomChargeRejectedError('the room has no in-house reservation.');
      }
      const folio = await trx.table('folios').where({ reservation_id: reservation.id, status: 'open' }).orderBy('id', 'asc').first();
      if (!folio) throw new RoomChargeRejectedError('the folio is closed or does not exist.');
      if (!roomCharge.authMethod || !roomCharge.authReference) {
        throw new ValidationError(
          'MISSING_FIELD',
          'Room-charge authorization (method + reference) is required — a room number alone is not identification.',
          [{ field: 'roomCharge', issue: 'missing_authorization' }]
        );
      }

      const { chargeLine, taxLines } = await cashieringService.postCharge({
        trx,
        folioId: folio.id,
        type: 'pos_charge',
        description: `POS charge — order ${orderId}`,
        amount: baseAmount,
        businessDate,
        userId: settledByUserId,
      });

      // Tip/service charge post as a SEPARATE, untaxed adjustment — folded
      // into the main charge's own taxed base would tax the tip, and this
      // codebase's tax engine has no mechanism to tax only part of one
      // charge. Skipped entirely when both are zero, so a plain sale posts
      // no empty adjustment line.
      let tipLineId = null;
      const tipTotal = sumMoney([tipAmount, serviceCharge]);
      if (compareMoney(tipTotal, '0.00') > 0) {
        const tipLine = await cashieringService.postAdjustment({
          trx,
          folioId: folio.id,
          description: `POS tip/service charge — order ${orderId}`,
          amount: tipTotal,
          relatedLineItemId: chargeLine.id,
          businessDate,
          userId: settledByUserId,
          reason: 'POS tip/service charge',
        });
        tipLineId = tipLine.id;
      }

      Object.assign(fields, {
        subtotal: chargeLine.amount,
        tax_amount: sumMoney(taxLines.map((t) => t.amount)),
        currency: chargeLine.currency,
        folio_id: folio.id,
        folio_line_item_id: chargeLine.id,
        tip_service_charge_line_item_id: tipLineId,
        room_charge_auth_method: roomCharge.authMethod,
        room_charge_auth_reference: roomCharge.authReference,
        tender: 'room_charge',
      });
    } else {
      const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate, chargeType: saleTaxChargeType });
      const { netAmount, taxLines } = computeChargeWithTax({ baseAmount, taxVersions });
      const taxAmount = sumMoney(taxLines.map((t) => t.amount));
      Object.assign(fields, {
        subtotal: netAmount,
        tax_amount: taxAmount,
        currency: property?.base_currency,
        tender: settlement.method === 'terminal' ? 'terminal' : 'cash',
      });

      // A card sale taken on the hotel's own physical terminal: nothing to
      // collect or verify (no gateway, no `payments` row), only the optional
      // provider/reference to reconcile against that terminal's own report.
      if (settlement.method === 'terminal') {
        Object.assign(fields, normalizeTerminalDetails(settlement.terminal));
        // The cashier picks one of THIS outlet's recorded accounts; its name and
        // last 4 are snapshotted here (no foreign key, so a later edit or removal
        // never rewrites this sale). Resolved HERE from the id, never from client
        // text. No pick leaves both null. The account's provider, when it has
        // one, is what the sale reports. Label only, no routing.
        if (settlement.terminalAccountId !== undefined && settlement.terminalAccountId !== null && settlement.terminalAccountId !== '') {
          const account = await trx.table('pos_outlet_terminal_accounts').where({ id: settlement.terminalAccountId, outlet_id: order.outlet_id }).first();
          if (!account) {
            throw new ValidationError('INVALID_TERMINAL_ACCOUNT', 'That account is not recorded for this outlet.', [{ field: 'terminal_account_id', issue: 'not_found' }]);
          }
          fields.terminal_account_label = (accountDisplayName(account) ?? '').slice(0, 80) || null;
          fields.terminal_account_last4 = lastFour(account.account_number);
          if (account.provider) fields.terminal_provider = account.provider;
        }
      }

      // Card and NQR only settle against money Paystack actually captured
      // for this exact check — never on the cashier's word alone.
      if (settlement.method === 'card') {
        // `claimPayment` is the supermarket online sale's own claim (its payment
        // has its own settlement target); every other caller claims a Register
        // payment exactly as before.
        const claim = claimPayment ?? claimRegisterPaymentForCheck;
        const payment = await claim({
          trx,
          orderId,
          splitGroup: settlement.splitGroup ?? null,
          paymentId: settlement.paymentId,
          total: sumMoney([netAmount, taxAmount, tipAmount, serviceCharge]),
          currency: property?.base_currency,
        });
        Object.assign(fields, { tender: payment.tender ?? 'card', payment_id: payment.id });
      }
    }

    const [settlementId] = await trx.table('pos_order_settlements').insert(fields);
    results.push(await trx.table('pos_order_settlements').where({ id: settlementId }).first());

    // PLAN.md Phase 6 (POS inventory & stock control) — deduct THIS
    // settlement's own group of items only, immediately after its own
    // settlement row exists (the deduction's `pos_order_settlement_id`
    // needs a real id to attribute to, and `voidSettlement`'s own reversal
    // lookup key depends on it). A menu item with no recipe at all costs
    // one cheap, empty lookup — see `stockService`'s own header.
    await stockService.deductStockForSettlement({
      trx,
      orderId,
      settlementId,
      items: groupItems,
      businessDate,
      userId: settledByUserId,
      overrideReasonsByStockItemId,
    });
  }

  await trx.table('pos_orders').where({ id: orderId }).update({ status: 'settled', closed_at: new Date() });
  const settledOrder = await trx.table('pos_orders').where({ id: orderId }).first();
  // A guest QR order settling (room charge) raises its own, richer
  // `qr_ordering.guest_order_placed` alert instead — never both.
  // A supermarket rings a sale every few seconds; a bell alert per sale would drown the bell.
  if (settledOrder.source !== 'guest' && !isSupermarketOutlet(saleOutlet)) await notifyStaff({
    trx,
    eventType: 'pos.order_settled',
    payload: {
      orderId,
      tableLabel: settledOrder.table_label ?? null,
      total: sumMoney(results.map(settlementTotal)),
      currency: results[0]?.currency ?? null,
      methods: [...new Set(results.map((row) => row.method))],
    },
  });
  return { order: settledOrder, settlements: results };
}

// ---------------------------------------------------------------------
// Register card/NQR checkout through Paystack — ARCHITECTURE.md §7
// ---------------------------------------------------------------------

// Paystack channels per Register button. Card offers every channel the
// merchant account supports (card, USSD, bank transfer, ...) — the channel
// the guest actually used is recorded at capture (`provider_channel`).
// NQR is the QR channel alone, for a guest scanning with a banking app.
const REGISTER_TENDERS = { card: null, nqr: ['qr'] };
const OPEN_REGISTER_PAYMENT_STATUSES = ['INITIATED', 'PENDING', 'CAPTURED'];

/** A Register payment still in play for this tab: not failed/cancelled, and not yet linked to a settlement. */
async function listUnsettledRegisterPayments({ db, orderId }) {
  const payments = await db
    .table('payments')
    .where({ pos_order_id: orderId, settlement_target: 'pos_register' })
    .whereIn('status', OPEN_REGISTER_PAYMENT_STATUSES)
    .orderBy('id');
  if (payments.length === 0) return [];
  // A voided settlement no longer accounts for its payment.
  const linked = await db.table('pos_order_settlements').whereIn('payment_id', payments.map((p) => p.id)).whereNull('voided_at');
  const linkedIds = new Set(linked.map((row) => String(row.payment_id)));
  return payments.filter((p) => !linkedIds.has(String(p.id)));
}

/**
 * Local half of a Register card/NQR checkout, inside the caller's
 * idempotency transaction: prices the check server-side (net + tax + the
 * fixed service charge — the same figures `previewSettlement` shows) and
 * returns the payment to take it with.
 *
 * Never starts a second charge for a check that already has one in play:
 * a CAPTURED payment is returned as-is (the caller settles with it), and an
 * unpaid one for the same amount and tender is reused so Paystack reopens
 * the same transaction. An unpaid one whose amount or tender no longer
 * matches (items changed, or the cashier switched Card to NQR) is
 * cancelled and replaced.
 */
async function prepareRegisterPayment({ trx, orderId, splitGroup, tender, idempotencyKey }) {
  if (!Object.hasOwn(REGISTER_TENDERS, tender ?? '')) {
    throw new ValidationError('INVALID_TENDER', '"tender" must be "card" or "nqr".', [{ field: 'tender', issue: 'invalid' }]);
  }
  const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
  if (!order) throw new OrderNotFoundError();
  if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

  const items = await trx.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at');
  const groupItems = items.filter((item) => groupKey(item.split_group) === groupKey(splitGroup));
  if (groupItems.length === 0) {
    throw new ValidationError('EMPTY_CHECK', 'This check has no items to pay for.', [{ field: 'split_group', issue: 'empty' }]);
  }

  const property = await trx.table('properties').where({ id: order.property_id }).first('current_business_date', 'base_currency');
  const saleOutlet = await trx.table('pos_outlets').where({ id: order.outlet_id }).first('type');
  const taxVersions = resolveApplicableTaxVersions({ allTaxRows: await trx.table('taxes'), businessDate: property?.current_business_date, chargeType: taxChargeTypeForOutlet(saleOutlet) });
  const { netAmount, taxLines } = computeChargeWithTax({ baseAmount: sumMoney(groupItems.map(computeItemLineTotal)), taxVersions });
  const amount = sumMoney([netAmount, ...taxLines.map((t) => t.amount), percentOfMoney(netAmount, POS_SERVICE_CHARGE_PERCENT)]);

  const existing = (await listUnsettledRegisterPayments({ db: trx, orderId })).filter((p) => groupKey(p.split_group) === groupKey(splitGroup));
  const captured = existing.find((p) => p.status === 'CAPTURED');
  if (captured) return captured;
  const reusable = existing.find((p) => p.tender === tender && compareMoney(p.amount, amount) === 0);
  if (reusable) return reusable;
  if (existing.length > 0) {
    await trx
      .table('payments')
      .whereIn('id', existing.map((p) => p.id))
      .whereIn('status', ['INITIATED', 'PENDING'])
      .update({ status: 'CANCELLED', failure_reason: 'Superseded — the check total or tender changed before payment.' });
  }

  return cashieringService.initiatePosRegisterPaymentIntent({
    trx,
    posOrderId: orderId,
    splitGroup,
    tender,
    amount,
    currency: property?.base_currency,
    idempotencyKey,
  });
}

/**
 * External half — opens (or reopens) the Paystack transaction, outside any
 * transaction. Paystack needs an email for its receipt; a walk-in customer
 * rarely gives one, so the cashier's own staff email stands in.
 */
async function startRegisterPaystackCheckout({ context, payment, customerEmail }) {
  if (payment.status === 'CAPTURED') return { payment, accessCode: null, authorizationUrl: null };
  const db = scopedDb().for(context);
  const staff = customerEmail ? null : await db.table('users').where({ id: context.userId }).first('email');
  return cashieringService.startPaystackCheckout({
    context,
    paymentId: payment.id,
    guestEmail: customerEmail || staff?.email,
    channels: REGISTER_TENDERS[payment.tender] ?? undefined,
  });
}

/** Re-checks a Register payment with Paystack after the popup closes. Returns null when the payment is not one of this tab's own. */
async function verifyRegisterPayment({ context, orderId, paymentId, userId }) {
  const db = scopedDb().for(context);
  const payment = await db.table('payments').where({ id: paymentId, pos_order_id: orderId, settlement_target: 'pos_register' }).first();
  if (!payment) return null;
  return cashieringService.verifyPayment({ context, paymentId: payment.id, userId });
}

/**
 * `settleOrder`'s card branch: locks the payment and checks it is a
 * captured Register payment for THIS order and check, not already used,
 * for exactly the check's total. The UNIQUE(payment_id) index on
 * `pos_order_settlements` backs the "not already used" rule.
 */
async function claimRegisterPaymentForCheck({ trx, orderId, splitGroup, paymentId, total, currency }) {
  if (!paymentId) throw new RegisterPaymentInvalidError('missing');
  const payment = await trx.table('payments').where({ id: paymentId }).forUpdate().first();
  if (!payment || payment.settlement_target !== 'pos_register') throw new RegisterPaymentInvalidError('not_found', { paymentId });
  if (String(payment.pos_order_id) !== String(orderId) || groupKey(payment.split_group) !== groupKey(splitGroup)) {
    throw new RegisterPaymentInvalidError('wrong_check', { paymentId });
  }
  if (payment.status !== 'CAPTURED') throw new RegisterPaymentInvalidError('not_captured', { paymentId, status: payment.status });
  if (await trx.table('pos_order_settlements').where({ payment_id: payment.id }).first()) {
    throw new RegisterPaymentInvalidError('already_used', { paymentId });
  }
  if (payment.currency !== currency) throw new RegisterPaymentInvalidError('currency_mismatch', { paymentId });
  if (compareMoney(payment.amount, total) !== 0) {
    throw new RegisterPaymentInvalidError('amount_mismatch', { paymentId, paid: payment.amount, total });
  }
  return payment;
}

/** Post-settlement void — PRODUCT_REQUIREMENTS.md §3.4's "Manager overrides ... require a manager PIN," gated on `pos.manage` at the route layer rather than a separate PIN-re-entry mechanism this codebase has no other example of. Voids the settlement record and, for a room charge, the underlying folio line via the existing `voidLineItem`. */
async function voidSettlement({ trx, settlementId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a settlement.', [{ field: 'reason', issue: 'missing' }]);
  const settlement = await trx.table('pos_order_settlements').where({ id: settlementId }).first();
  if (!settlement) throw new ValidationError('SETTLEMENT_NOT_FOUND', 'The specified settlement does not exist.');

  // Lock the parent order, then re-check voided_at under that lock — the
  // same reasoning `lockOrderAndItem` gives for pre-settlement item voids,
  // applied here so two concurrent void-settlement calls (each with its
  // own idempotency key, so idempotency replay does not dedupe them) can't
  // both pass the check before either writes.
  await trx.table('pos_orders').where({ id: settlement.pos_order_id }).forUpdate().first();
  // A locking read, not a plain SELECT — see `lockOrderAndItem`'s own
  // comment for why a plain re-read here would still see the pre-void
  // REPEATABLE-READ snapshot even after a concurrent voider committed.
  const lockedSettlement = await trx.table('pos_order_settlements').where({ id: settlementId }).forUpdate().first();
  if (lockedSettlement.voided_at) throw new SettlementAlreadyVoidedError(settlementId);
  if (lockedSettlement.payment_id) throw new SettlementPaidByGatewayError(settlementId, lockedSettlement.payment_id);

  if (settlement.folio_line_item_id) {
    await cashieringService.voidLineItem({ trx, lineItemId: settlement.folio_line_item_id, reason, userId });
  }
  // The tip/service-charge adjustment (if any) is a separate folio line —
  // void it too, so a voided settlement never leaves an orphaned tip
  // charge behind on the guest's folio.
  if (settlement.tip_service_charge_line_item_id) {
    await cashieringService.voidLineItem({ trx, lineItemId: settlement.tip_service_charge_line_item_id, reason, userId });
  }

  // PLAN.md Phase 6 (POS inventory & stock control) — the direct
  // counterpart of `settleOrder`'s own deduction call above: every
  // `sold` stock movement this settlement posted is reversed, restoring
  // the quantity it consumed under its OWN original cost/business_date
  // (see `stockService.reverseStockForSettlement`'s own header).
  await stockService.reverseStockForSettlement({ trx, settlementId, userId });

  await trx.table('pos_order_settlements').where({ id: settlementId }).update({
    voided_at: new Date(),
    void_reason: reason,
    voided_by_user_id: userId,
  });
  const voidedOrder = await trx.table('pos_orders').where({ id: settlement.pos_order_id }).first();
  await notifyStaff({
    trx,
    eventType: 'pos.settlement_voided',
    payload: {
      orderId: settlement.pos_order_id,
      settlementId,
      tableLabel: voidedOrder?.table_label ?? null,
      total: settlementTotal(settlement),
      currency: settlement.currency,
      reason,
    },
  });
  return trx.table('pos_order_settlements').where({ id: settlementId }).first();
}

// ---------------------------------------------------------------------
// Shifts — blind cash-up
// ---------------------------------------------------------------------

/** Carries the terminal's device_ref and the opener's name so the history table can be reviewed without a second lookup (a pos_operator holds no grant to read the staff directory). */
/** `outletIds` (optional, from staff outlet assignments) limits the list to shifts on those outlets' terminals. */
async function listShifts({ context, terminalId, outletIds = null }) {
  const db = scopedDb().for(context);
  const query = db
    .table('pos_shifts')
    .joinScoped('pos_terminals', (join) => join.on('pos_terminals.id', '=', 'pos_shifts.terminal_id'))
    .joinScoped('users', (join) => join.on('users.id', '=', 'pos_shifts.user_id'))
    .select('pos_shifts.*', 'pos_terminals.device_ref as terminal_device_ref', 'users.first_name as opened_by_first_name', 'users.last_name as opened_by_last_name');
  const scoped = outletIds ? query.whereIn('pos_terminals.outlet_id', outletIds) : query;
  return (terminalId ? scoped.where({ 'pos_shifts.terminal_id': terminalId }) : scoped).orderBy('pos_shifts.opened_at', 'desc').orderBy('pos_shifts.id', 'desc');
}

async function getShift({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_shifts').where({ id }).first();
}

/**
 * Every operation that decides which shift a sale belongs to takes the
 * terminal's row lock FIRST, by primary key: `openShift`/`closeShift`
 * exclusively, `settleOrder` shared. One lock, one order.
 *
 * Bug fix (the "test and review Shifts" pass, reproduced under CPU load):
 * locking the shift row directly deadlocked — `settleOrder` locked it via
 * the (terminal_id, closed_at) index then the primary key, while
 * `closeShift` locked the primary key and then needed that same index
 * entry to write `closed_at`. Serializing on the terminal row first means
 * neither ever holds one of those locks while waiting for the other.
 */
async function lockTerminalForShifts(trx, terminalId, mode) {
  const query = trx.table('pos_terminals').where({ id: terminalId });
  return (mode === 'share' ? query.forShare() : query.forUpdate()).first('id', 'status');
}

/** No idempotency key required — retrying a rejected open is naturally safe (the gap-lock guard below either accepts a genuinely-new shift or rejects a duplicate), and opening carries no money yet. */
async function openShift({ context, terminalId, userId, openingFloat }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    // A shift can only be opened on a real, active terminal at this
    // property — without this check a bad or foreign id reached the insert
    // and surfaced as a raw FK-violation 500.
    const terminal = await lockTerminalForShifts(trx, terminalId, 'update');
    if (!terminal || terminal.status !== 'active') throw new TerminalNotFoundError();

    // Gap lock: MySQL's unique-index semantics treat every NULL as distinct,
    // so no DB constraint alone can enforce "at most one open shift per
    // terminal" — see the migration's own header for the full reasoning.
    const existingOpen = await trx.table('pos_shifts').where({ terminal_id: terminalId }).whereNull('closed_at').forUpdate().first();
    if (existingOpen) throw new ShiftAlreadyOpenError(terminalId);

    const property = await trx.table('properties').where({ id: context.propertyId }).first('base_currency');
    const [id] = await trx.table('pos_shifts').insert({ terminal_id: terminalId, user_id: userId, opening_float: openingFloat, currency: property.base_currency });
    return trx.table('pos_shifts').where({ id }).first();
  });
}

/**
 * `trx`-based, called from `runIdempotentMutation` — closing a shift
 * records a fact (the counted cash) that must not double-process on a
 * retried request. `countedCash` is the caller's INPUT; `expected_cash`/
 * `variance` are computed here and returned in the SAME response — no
 * earlier read of an open shift ever exposes what the system expects
 * (PRODUCT_REQUIREMENTS.md §3.19's "blind cash-up," structural, not a UI
 * convention — see migration header).
 */
async function closeShift({ trx, shiftId, countedCash, userId, canCloseForOthers = false, reason }) {
  // terminal_id never changes, so a plain read is enough to find which
  // terminal to lock; the state that matters is re-read under that lock.
  const located = await trx.table('pos_shifts').where({ id: shiftId }).first('terminal_id');
  if (!located) throw new ShiftNotFoundError();
  await lockTerminalForShifts(trx, located.terminal_id, 'update');

  const shift = await trx.table('pos_shifts').where({ id: shiftId }).forUpdate().first();
  if (shift.closed_at) throw new ShiftAlreadyClosedError(shiftId);
  // Security fix (POS review): the opener closes their own till; anyone
  // else needs `pos.manage` and a reason (recorded on the audit row).
  if (String(shift.user_id) !== String(userId)) {
    if (!canCloseForOthers) throw new ShiftNotYoursError(shiftId);
    if (!reason || !String(reason).trim()) {
      throw new ValidationError('REASON_REQUIRED', 'A reason is required to close another operator\'s shift.', [{ field: 'reason', issue: 'missing' }]);
    }
  }

  // By the shift id `settleOrder` stamped, never by time: a same-second
  // hand-over used to count the previous shift's sales again (see the
  // pos_shift_id migration's header).
  //
  // A locking read, not a plain SELECT: this transaction's REPEATABLE READ
  // snapshot was fixed by its first read (the idempotency-key lookup),
  // before the terminal lock above was granted. A sale that stamped this
  // shift and committed while we waited for that lock is invisible to a
  // plain read, and its cash would drop out of the cash-up — the race
  // tests/pos/concurrency.test.js reproduced under load.
  const cashSettlements = await trx
    .table('pos_order_settlements')
    .where({ pos_shift_id: shift.id, method: 'cash' })
    .whereNull('voided_at')
    .forShare()
    .select('subtotal', 'tax_amount', 'tip_amount', 'service_charge');

  const cashTaken = sumMoney(
    cashSettlements.map((s) => sumMoney([s.subtotal, s.tax_amount, s.tip_amount, s.service_charge]))
  );
  const expectedCash = sumMoney([shift.opening_float, cashTaken]);
  const variance = sumMoney([countedCash, negateMoney(expectedCash)]);

  await trx.table('pos_shifts').where({ id: shiftId }).update({
    counted_cash: countedCash,
    expected_cash: expectedCash,
    variance,
    closed_at: new Date(),
  });
  return trx.table('pos_shifts').where({ id: shiftId }).first();
}

module.exports = {
  TERMINAL_PROVIDERS,
  listTransferCandidates,
  transferTabs,
  listOutlets,
  getOutlet,
  createOutlet,
  updateOutlet,
  archiveOutlet,
  listTerminals,
  getTerminal,
  createTerminal,
  updateTerminal,
  archiveTerminal,
  listMenuCategories,
  getMenuCategory,
  createMenuCategory,
  updateMenuCategory,
  archiveMenuCategory,
  listMenuItems,
  getMenuItem,
  createMenuItem,
  updateMenuItem,
  setMenuItemAvailability,
  setOutletMenuItemPrice,
  setOutletCategories,
  listOutletTerminalAccounts,
  createOutletTerminalAccount,
  updateOutletTerminalAccount,
  listOutletTerminalAccountOptions,
  removeOutletTerminalAccount,
  getOutletPayoutAccount,
  resolveOutletPayoutBankAccount,
  verifyOutletPayoutAccount,
  setOutletPayoutAccount,
  clearOutletPayoutAccount,
  archiveMenuItem,
  setMenuItemImage,
  removeMenuItemImage,
  findInHouseForCharge,
  listOrders,
  listKitchenTickets,
  markTicketDone,
  getOrder,
  listOrderItems,
  listOrderSettlements,
  openOrder,
  addItem,
  voidOrderItem,
  assignItemSplitGroup,
  voidOrder,
  renameOrder,
  computeItemLineTotal,
  previewSettlement,
  settleOrder,
  voidSettlement,
  listUnsettledRegisterPayments,
  prepareRegisterPayment,
  startRegisterPaystackCheckout,
  verifyRegisterPayment,
  listShifts,
  getShift,
  openShift,
  closeShift,
};
