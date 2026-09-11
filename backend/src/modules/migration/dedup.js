'use strict';

/**
 * Guest deduplication — PRODUCT_REQUIREMENTS.md §3.20: "match incoming
 * guests on email, then phone, then name + date of birth." Pure, no
 * database — takes `existingGuests` already loaded by the caller (the
 * tenant's full guest roster, read once per dry run) so this stays a plain,
 * directly-testable function.
 *
 * Three tiers, tried IN ORDER, stopping at the first tier that produces any
 * match — email is the strongest signal, phone next, name+DOB last and
 * weakest. Every match AT the winning tier is surfaced, not just the
 * first: `guests` carries no uniqueness constraint on any of these fields
 * (two guests can legitimately share an email — a family booking under one
 * address), so a real import could match more than one existing guest at
 * the same tier, and presenting only one would silently hide a real
 * decision the operator needs to make (§3.20: "present likely duplicates
 * for a human decision... never silently merging or silently duplicating").
 *
 * Returns `null` when nothing matches at any tier (a genuinely new guest —
 * commit will create one). Otherwise `{ tier, matches: [{id, firstName,
 * lastName, email, phone, dateOfBirth}] }`.
 */

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function normalizePhone(value) {
  // Digits only — "+234 803 555 0101" and "08035550101" should collide.
  return value ? String(value).replace(/[^0-9]/g, '') : null;
}

function normalizeName(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function formatMatch(guest) {
  return {
    id: guest.id,
    firstName: guest.first_name,
    lastName: guest.last_name,
    email: guest.email,
    phone: guest.phone,
    dateOfBirth: guest.date_of_birth ?? null,
  };
}

/**
 * Resolves a `reservations`-import row's `guest_email`/`guest_phone`
 * against the tenant's already-imported/pre-existing guest roster — a
 * DIFFERENT question from `findDuplicateCandidates` above (that one asks
 * "is THIS new guest row a duplicate of one already here"; this one asks
 * "which already-real guest does this reservation belong to," since
 * `reservations` rows must reference an existing guest, never create one
 * inline — see the migration module's own deliberately-deferred scope
 * list). Returns `null` (no match — the row's own error), `'ambiguous'`
 * (more than one match — refuse rather than guess), or a single guest id.
 */
function matchExistingGuestByContact({ email, phone }, existingGuests) {
  const normalizedEmail = normalizeEmail(email);
  let matches = normalizedEmail ? existingGuests.filter((guest) => normalizeEmail(guest.email) === normalizedEmail) : [];
  if (!matches.length) {
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) matches = existingGuests.filter((guest) => normalizePhone(guest.phone) === normalizedPhone);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0].id;
}

/** The `ar_balances` import's equivalent of `matchExistingGuestByContact` — resolves `company_email` against the tenant's existing company roster. `company_profiles.billing_email` carries no UNIQUE constraint, so more than one company can legitimately share one — ambiguous, same as guest matching. */
function matchExistingCompanyByEmail(email, existingCompanies) {
  const normalizedEmailValue = normalizeEmail(email);
  if (!normalizedEmailValue) return null;
  const matches = existingCompanies.filter((company) => normalizeEmail(company.billing_email) === normalizedEmailValue);
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0].id;
}

function findDuplicateCandidates({ importedRow, existingGuests }) {
  const email = normalizeEmail(importedRow.email);
  if (email) {
    const matches = existingGuests.filter((guest) => normalizeEmail(guest.email) === email);
    if (matches.length) return { tier: 'email', matches: matches.map(formatMatch) };
  }

  const phone = normalizePhone(importedRow.phone);
  if (phone) {
    const matches = existingGuests.filter((guest) => normalizePhone(guest.phone) === phone);
    if (matches.length) return { tier: 'phone', matches: matches.map(formatMatch) };
  }

  const firstName = normalizeName(importedRow.first_name);
  const lastName = normalizeName(importedRow.last_name);
  const dateOfBirth = importedRow.date_of_birth ? String(importedRow.date_of_birth).trim() : null;
  if (firstName && lastName && dateOfBirth) {
    const matches = existingGuests.filter(
      (guest) =>
        normalizeName(guest.first_name) === firstName &&
        normalizeName(guest.last_name) === lastName &&
        guest.date_of_birth &&
        String(guest.date_of_birth).slice(0, 10) === dateOfBirth.slice(0, 10)
    );
    if (matches.length) return { tier: 'name_dob', matches: matches.map(formatMatch) };
  }

  return null;
}

module.exports = { findDuplicateCandidates, matchExistingGuestByContact, matchExistingCompanyByEmail };
