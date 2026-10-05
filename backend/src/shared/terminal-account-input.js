'use strict';

/**
 * Validation and display of a terminal account record (a bank account a card terminal pays into): shared by the
 * POS outlet accounts (`pos/service.js`) and the hotel's property-level accounts for room/folio payments
 * (`cashiering/terminal-accounts.js`), so the two cannot drift apart. RECORDING ONLY: no money is routed.
 */

const { ValidationError } = require('./errors');

/**
 * Providers that can hold an outlet account. `other` covers any terminal not
 * listed; with no provider name of its own, its account is identified by its
 * label, which is therefore required (the bank is free text, never validated).
 */
const ACCOUNT_PROVIDERS = ['moniepoint', 'opay', 'gtbank', 'other'];

function lastFour(accountNumber) {
  return String(accountNumber).replace(/\s+/g, '').slice(-4);
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

module.exports = { ACCOUNT_PROVIDERS, lastFour, normalizeAccountProvider, optionalText, accountDisplayName, normalizeAccountInput };
