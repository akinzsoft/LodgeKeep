'use strict';

/**
 * The four CSV column templates — PRODUCT_REQUIREMENTS.md §3.20: "publish a
 * column template per entity rather than trying to parse arbitrary
 * spreadsheets. Ambiguous manual mapping is where migrations go wrong."
 *
 * Pure data, directly reusable by both the template-download route (headers
 * only, no data rows) and `validate.js`/`service.js` (which columns a row
 * is expected to carry, in what order, for error messages that name a real
 * column rather than a bare array index).
 */

const TEMPLATE_COLUMNS = Object.freeze({
  guests: Object.freeze(['first_name', 'last_name', 'email', 'phone', 'date_of_birth']),
  reservations: Object.freeze([
    'guest_email',
    'guest_phone',
    'room_type_code',
    'rate_code',
    'arrival_date',
    'departure_date',
    'adults',
    'children',
    'status',
    'room_number',
  ]),
  companies: Object.freeze(['name', 'type', 'billing_email', 'billing_phone', 'billing_address', 'payment_terms_days']),
  ar_balances: Object.freeze(['company_email', 'amount', 'currency', 'credit_limit', 'enforcement_mode']),
});

const ENTITY_TYPES = Object.freeze(Object.keys(TEMPLATE_COLUMNS));

function columnsForEntityType(entityType) {
  return TEMPLATE_COLUMNS[entityType] ?? null;
}

/** Header-row-only CSV text for the template-download route — no data rows, per §3.20's own "publish a column template" text. */
function templateCsv(entityType) {
  const columns = columnsForEntityType(entityType);
  if (!columns) return null;
  return `${columns.join(',')}\n`;
}

module.exports = { TEMPLATE_COLUMNS, ENTITY_TYPES, columnsForEntityType, templateCsv };
