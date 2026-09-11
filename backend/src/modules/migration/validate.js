'use strict';

/**
 * Per-entity-type row validation — PRODUCT_REQUIREMENTS.md §3.20: "row
 * count, rows that will be created vs skipped, and a per-row error list
 * (missing required fields, invalid dates, unknown room types, departure
 * before arrival)." Pure functions, no database — every piece of reference
 * data a validator needs (room types, rate codes, existing guests/
 * companies) is loaded once by the caller and passed in, so this file
 * stays directly unit-testable.
 *
 * Each validator returns an array of `{ columnName, message }` findings for
 * one row — empty means the row is clean. `validate.js` never decides
 * severity or resolution; `service.js`'s dry-run orchestration turns a
 * non-empty array into `import_row_errors` rows.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const RESERVATION_STATUSES = ['waitlisted', 'tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'expired'];
const COMPANY_TYPES = ['company', 'travel_agent', 'source'];
const ENFORCEMENT_MODES = ['block', 'flag_only'];

function trimmed(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
}

function validateGuestRow(row) {
  const errors = [];
  if (!trimmed(row.first_name)) errors.push({ columnName: 'first_name', message: '"first_name" is required.' });
  if (!trimmed(row.last_name)) errors.push({ columnName: 'last_name', message: '"last_name" is required.' });
  if (!trimmed(row.email) && !trimmed(row.phone)) {
    errors.push({ columnName: 'email', message: 'At least one of "email" or "phone" is required.' });
  }
  if (trimmed(row.date_of_birth) && !isValidDate(trimmed(row.date_of_birth))) {
    errors.push({ columnName: 'date_of_birth', message: '"date_of_birth" must be a valid date in YYYY-MM-DD format.' });
  }
  return errors;
}

function validateCompanyRow(row) {
  const errors = [];
  if (!trimmed(row.name)) errors.push({ columnName: 'name', message: '"name" is required.' });
  const type = trimmed(row.type);
  if (type && !COMPANY_TYPES.includes(type)) {
    errors.push({ columnName: 'type', message: `"type" must be one of: ${COMPANY_TYPES.join(', ')}.` });
  }
  const paymentTermsDays = trimmed(row.payment_terms_days);
  if (paymentTermsDays && (!/^\d+$/.test(paymentTermsDays) || Number(paymentTermsDays) < 0)) {
    errors.push({ columnName: 'payment_terms_days', message: '"payment_terms_days" must be a non-negative whole number.' });
  }
  return errors;
}

/**
 * `guestMatch` — the caller's own resolution of guest_email/guest_phone
 * against the tenant's real guest roster: `null` (nothing resolves yet —
 * the row's own guest hasn't been imported, or doesn't exist),
 * `'ambiguous'` (more than one guest matches, refuse rather than guess), or
 * a single guest id. `roomTypeExists`/`rateCodeExists` are plain booleans
 * the caller already resolved against the target property's real reference
 * data.
 */
function validateReservationRow(row, { guestMatch, roomTypeExists, rateCodeExists }) {
  const errors = [];
  if (!trimmed(row.guest_email) && !trimmed(row.guest_phone)) {
    errors.push({ columnName: 'guest_email', message: 'At least one of "guest_email" or "guest_phone" is required to identify the guest.' });
  } else if (guestMatch === null) {
    errors.push({ columnName: 'guest_email', message: 'No matching guest found for this email/phone — import guests before reservations that reference them.' });
  } else if (guestMatch === 'ambiguous') {
    errors.push({ columnName: 'guest_email', message: 'More than one existing guest matches this email/phone — cannot resolve which one this reservation belongs to.' });
  }

  if (!trimmed(row.room_type_code)) {
    errors.push({ columnName: 'room_type_code', message: '"room_type_code" is required.' });
  } else if (!roomTypeExists) {
    errors.push({ columnName: 'room_type_code', message: `Unknown room type code "${trimmed(row.room_type_code)}" at this property.` });
  }

  if (!trimmed(row.rate_code)) {
    errors.push({ columnName: 'rate_code', message: '"rate_code" is required.' });
  } else if (!rateCodeExists) {
    errors.push({ columnName: 'rate_code', message: `Unknown rate code "${trimmed(row.rate_code)}" at this property.` });
  }

  const arrivalDate = trimmed(row.arrival_date);
  const departureDate = trimmed(row.departure_date);
  if (!arrivalDate || !isValidDate(arrivalDate)) {
    errors.push({ columnName: 'arrival_date', message: '"arrival_date" must be a valid date in YYYY-MM-DD format.' });
  }
  if (!departureDate || !isValidDate(departureDate)) {
    errors.push({ columnName: 'departure_date', message: '"departure_date" must be a valid date in YYYY-MM-DD format.' });
  }
  if (arrivalDate && departureDate && isValidDate(arrivalDate) && isValidDate(departureDate) && !(departureDate > arrivalDate)) {
    errors.push({ columnName: 'departure_date', message: '"departure_date" must be after "arrival_date".' });
  }

  const adults = trimmed(row.adults);
  if (adults && (!/^\d+$/.test(adults) || Number(adults) < 1)) {
    errors.push({ columnName: 'adults', message: '"adults" must be a whole number of at least 1.' });
  }
  const children = trimmed(row.children);
  if (children && !/^\d+$/.test(children)) {
    errors.push({ columnName: 'children', message: '"children" must be a non-negative whole number.' });
  }

  const status = trimmed(row.status);
  if (status && !RESERVATION_STATUSES.includes(status)) {
    errors.push({ columnName: 'status', message: `"status" must be one of: ${RESERVATION_STATUSES.join(', ')}.` });
  }

  return errors;
}

/** `companyExists` — the caller's own resolution of company_email against the tenant's real company roster. */
function validateArBalanceRow(row, { companyExists }) {
  const errors = [];
  if (!trimmed(row.company_email)) {
    errors.push({ columnName: 'company_email', message: '"company_email" is required.' });
  } else if (!companyExists) {
    errors.push({ columnName: 'company_email', message: 'No matching company found for this email — import companies before their AR balances.' });
  }

  const amount = trimmed(row.amount);
  if (!amount) {
    errors.push({ columnName: 'amount', message: '"amount" is required.' });
  } else if (!MONEY_PATTERN.test(amount) || Number(amount) <= 0) {
    errors.push({ columnName: 'amount', message: '"amount" must be a positive number with at most 2 decimal places.' });
  }

  if (!trimmed(row.currency)) {
    errors.push({ columnName: 'currency', message: '"currency" is required.' });
  } else if (!/^[A-Z]{3}$/.test(trimmed(row.currency))) {
    errors.push({ columnName: 'currency', message: '"currency" must be a 3-letter ISO 4217 code.' });
  }

  const creditLimit = trimmed(row.credit_limit);
  if (creditLimit && !MONEY_PATTERN.test(creditLimit)) {
    errors.push({ columnName: 'credit_limit', message: '"credit_limit" must be a non-negative number with at most 2 decimal places.' });
  }

  const enforcementMode = trimmed(row.enforcement_mode);
  if (enforcementMode && !ENFORCEMENT_MODES.includes(enforcementMode)) {
    errors.push({ columnName: 'enforcement_mode', message: `"enforcement_mode" must be one of: ${ENFORCEMENT_MODES.join(', ')}.` });
  }

  return errors;
}

module.exports = {
  RESERVATION_STATUSES,
  COMPANY_TYPES,
  ENFORCEMENT_MODES,
  isValidDate,
  validateGuestRow,
  validateCompanyRow,
  validateReservationRow,
  validateArBalanceRow,
};
