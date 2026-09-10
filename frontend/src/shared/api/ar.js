import { request, requestWithMeta, requestBlob } from './client.js';

/**
 * Accounts Receivable (AR) endpoint wrappers — PLAN.md Phase 4,
 * PRODUCT_REQUIREMENTS.md §3.9. Same shape as `cashiering.js`: plain
 * exported functions, each a thin wrapper over `request()`, matching the
 * real backend response shapes in `backend/src/modules/ar`.
 *
 * Every mutation carries a fresh `Idempotency-Key` header (ARCHITECTURE.md
 * §7), generated internally — never a caller-supplied parameter, the same
 * "one key per logical attempt" convention `cashiering.js`/`reservations.js`
 * already established.
 */

function idempotencyKey() {
  return crypto.randomUUID();
}

/** `[{ invoiceId, amount }]` (camelCase, this file's own callers) -> `[{ invoice_id, amount }]` over the wire, matching `ar/controller.js`'s `normalizeApplications`. */
function toWireApplications(applications) {
  if (!Array.isArray(applications)) return undefined;
  return applications.map((application) => ({ invoice_id: application.invoiceId, amount: application.amount }));
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

export function listAccounts() {
  return request('/ar/accounts');
}

export function getAccount(id) {
  return request(`/ar/accounts/${id}`);
}

/** @param {{companyProfileId: string, currency: string, creditLimit?: string, enforcementMode?: 'block'|'flag_only'}} params */
export function createAccount({ companyProfileId, currency, creditLimit, enforcementMode }) {
  return request('/ar/accounts', {
    method: 'POST',
    body: { company_profile_id: companyProfileId, currency, credit_limit: creditLimit, enforcement_mode: enforcementMode },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} id @param {{creditLimit?: string, enforcementMode?: 'block'|'flag_only', status?: 'active'|'closed'}} changes */
export function updateAccount(id, { creditLimit, enforcementMode, status } = {}) {
  return request(`/ar/accounts/${id}`, {
    method: 'PATCH',
    body: { credit_limit: creditLimit, enforcement_mode: enforcementMode, status },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

// ---------------------------------------------------------------------
// Invoices — TESTING.md AR-1
// ---------------------------------------------------------------------

export function listInvoicesForAccount(accountId) {
  return request(`/ar/accounts/${accountId}/invoices`);
}

export function getInvoice(id) {
  return request(`/ar/invoices/${id}`);
}

/** @param {string} accountId @param {{groupBlockId?: string}} [params] PLAN.md Phase 4 (Group Blocks) — optionally scopes the generated invoice to one block's own charges. */
export function generateInvoice(accountId, { groupBlockId } = {}) {
  return request(`/ar/accounts/${accountId}/invoices`, {
    method: 'POST',
    body: { group_block_id: groupBlockId },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

export function voidInvoice(id, reason) {
  return request(`/ar/invoices/${id}/void`, {
    method: 'POST',
    body: { reason },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

// ---------------------------------------------------------------------
// Payments — manual recording only, no gateway
// ---------------------------------------------------------------------

export function listPaymentsForAccount(accountId) {
  return request(`/ar/accounts/${accountId}/payments`);
}

/** @param {string} accountId @param {{amount: string, currency: string, methodLabel: string, reference?: string, receivedAt?: string, applications?: {invoiceId: string, amount: string}[]}} params */
export function recordPayment(accountId, { amount, currency, methodLabel, reference, receivedAt, applications }) {
  return request(`/ar/accounts/${accountId}/payments`, {
    method: 'POST',
    body: {
      amount,
      currency,
      method_label: methodLabel,
      reference,
      received_at: receivedAt,
      applications: toWireApplications(applications),
    },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

/** @param {string} paymentId @param {{invoiceId: string, amount: string}[]} applications */
export function applyPayment(paymentId, applications) {
  return request(`/ar/payments/${paymentId}/apply`, {
    method: 'POST',
    body: { applications: toWireApplications(applications) },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

export function voidPayment(paymentId, reason) {
  return request(`/ar/payments/${paymentId}/void`, {
    method: 'POST',
    body: { reason },
    headers: { 'Idempotency-Key': idempotencyKey() },
  });
}

// ---------------------------------------------------------------------
// Ageing report — TESTING.md AR-2
// ---------------------------------------------------------------------

/**
 * The backend returns the per-company rows as `data` and `{asOfDate, total}`
 * as `meta` (`ar/controller.js`'s `getAgeingReport`) — the identical
 * "a field genuinely isn't a property of the created/listed resource
 * itself" shape `capturePaystackPayment`/`portal.js` already needed
 * `requestWithMeta` for, so this flattens the same way rather than
 * silently discarding `meta` the way plain `request()` would.
 */
export async function getAgeingReport() {
  const { data, meta } = await requestWithMeta('/ar/ageing');
  return { rows: data, asOfDate: meta?.asOfDate, total: meta?.total };
}

export function getAgeingReportCsv() {
  return requestBlob('/ar/ageing?format=csv');
}
