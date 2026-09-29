'use strict';

/**
 * Input checks for one POS order line, shared by the staff Register
 * (`pos/service.js` `addItem`) and anonymous QR ordering
 * (`qr-ordering/service.js` `createGuestOrder`), plus the admin's modifier
 * catalogue on a menu item.
 *
 * Security fix (POS review): both order paths used to take a line's
 * `modifiers` from the request, `priceDelta` included, and price the line
 * from it — so a caller (including an anonymous guest holding a QR code)
 * could send an invented or negative delta and lower the bill. Quantity
 * went straight into `BigInt(quantity)` and the insert unchecked. Now:
 *
 * - a client names a modifier CHOICE only (`{name, option}`); the price
 *   delta always comes from the live menu item's own catalogue, and any
 *   `priceDelta` the client sends is ignored;
 * - a choice the item does not offer, or two choices in one group, is
 *   rejected;
 * - a line whose per-unit price would fall below zero is rejected;
 * - quantity must be a whole number from 1 to MAX_LINE_QUANTITY.
 */

const { ValidationError } = require('./errors');
const { toCents } = require('./money');

const MAX_LINE_QUANTITY = 999;
const MONEY_DELTA = /^-?\d+(\.\d{1,2})?$/;

/** A line's quantity: absent means 1; otherwise a whole number 1..999 (number or digit string). */
function normalizeQuantity(raw, field = 'quantity') {
  if (raw === undefined || raw === null) return 1;
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LINE_QUANTITY) {
    throw new ValidationError('INVALID_QUANTITY', `Quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}.`, [{ field, issue: 'invalid' }]);
  }
  return value;
}

/** A JSON column may come back parsed or as text depending on the driver path. */
function parseJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

const nameKey = (value) => String(value).trim().toLowerCase();

function modifierError(message, field = 'modifiers') {
  return new ValidationError('INVALID_MODIFIERS', message, [{ field, issue: 'invalid' }]);
}

/**
 * The admin's catalogue for a menu item: `[{name, options: [{label, priceDelta}]}]`,
 * or null/[] for none. Returns the cleaned catalogue (trimmed names, deltas as
 * strings) or null; throws on a malformed one so it can never reach pricing.
 * A negative delta is allowed here ("no cheese −50"); the order line itself
 * is still refused if it would price below zero.
 */
function normalizeModifierCatalogue(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) throw modifierError('Modifiers must be a list of groups.');
  if (raw.length === 0) return null;
  const seenGroups = new Set();
  return raw.map((group, groupIndex) => {
    const name = typeof group?.name === 'string' ? group.name.trim() : '';
    if (!name) throw modifierError(`Modifier group ${groupIndex + 1} needs a name.`);
    if (seenGroups.has(nameKey(name))) throw modifierError(`Modifier group "${name}" appears twice.`);
    seenGroups.add(nameKey(name));
    if (!Array.isArray(group.options) || group.options.length === 0) throw modifierError(`Modifier group "${name}" needs at least one option.`);
    const seenOptions = new Set();
    const options = group.options.map((option) => {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      if (!label) throw modifierError(`Every option in "${name}" needs a label.`);
      if (seenOptions.has(nameKey(label))) throw modifierError(`Option "${label}" appears twice in "${name}".`);
      seenOptions.add(nameKey(label));
      const delta = option.priceDelta == null ? '0.00' : String(option.priceDelta).trim();
      if (!MONEY_DELTA.test(delta)) throw modifierError(`The price change for "${label}" must be an amount with at most 2 decimal places.`);
      return { label, priceDelta: delta };
    });
    return { name, options };
  });
}

/**
 * Resolves a line's chosen modifiers against the menu item's catalogue.
 * `chosen` is `[{name, option}]` (anything else on an entry, `priceDelta`
 * included, is ignored). Returns the snapshot to store on the order line —
 * `[{name, option, priceDelta}]` with the catalogue's own spelling and
 * price — or null when nothing was chosen.
 */
function resolveModifierSelections({ menuItem, chosen }) {
  if (chosen === undefined || chosen === null) return null;
  if (!Array.isArray(chosen)) throw modifierError('Modifiers must be a list of choices.');
  if (chosen.length === 0) return null;

  const catalogue = parseJsonColumn(menuItem.modifiers) ?? [];
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw modifierError(`"${menuItem.name}" has no modifiers to choose from.`);
  }
  if (chosen.length > catalogue.length) throw modifierError('More modifier choices were sent than this item offers.');

  const usedGroups = new Set();
  const resolved = chosen.map((entry) => {
    if (typeof entry?.name !== 'string' || typeof entry?.option !== 'string') {
      throw modifierError('Each modifier choice needs a group name and an option.');
    }
    const group = catalogue.find((candidate) => typeof candidate?.name === 'string' && nameKey(candidate.name) === nameKey(entry.name));
    if (!group) throw modifierError(`"${menuItem.name}" does not offer "${entry.name}".`);
    if (usedGroups.has(nameKey(group.name))) throw modifierError(`Only one choice is allowed for "${group.name}".`);
    usedGroups.add(nameKey(group.name));
    const option = (Array.isArray(group.options) ? group.options : []).find(
      (candidate) => typeof candidate?.label === 'string' && nameKey(candidate.label) === nameKey(entry.option)
    );
    if (!option) throw modifierError(`"${entry.option}" is not an option for "${group.name}".`);
    const priceDelta = option.priceDelta == null ? '0.00' : String(option.priceDelta).trim();
    if (!MONEY_DELTA.test(priceDelta)) throw modifierError(`"${group.name}" is set up with an invalid price.`);
    return { name: group.name, option: option.label, priceDelta };
  });
  return resolved;
}

/**
 * Validates one order line against the live menu item as sold at the outlet
 * (`unit_price` already resolved to that outlet's price): returns the
 * quantity and the modifier snapshot to store. Refuses a line that would
 * price below zero per unit.
 */
function resolveOrderLine({ menuItem, unitPrice, quantity, modifiers }) {
  const normalizedQuantity = normalizeQuantity(quantity);
  const resolvedModifiers = resolveModifierSelections({ menuItem, chosen: modifiers });
  const perUnitCents = (resolvedModifiers ?? []).reduce((sum, m) => sum + toCents(m.priceDelta), toCents(unitPrice));
  if (perUnitCents < 0n) throw modifierError(`The chosen modifiers would price "${menuItem.name}" below zero.`);
  return { quantity: normalizedQuantity, modifiers: resolvedModifiers };
}

/** The snapshot as a JSON column value (mysql2 would expand a bare array into a list). */
function modifiersForInsert(modifiers) {
  return modifiers == null ? null : JSON.stringify(modifiers);
}

module.exports = {
  MAX_LINE_QUANTITY,
  normalizeQuantity,
  normalizeModifierCatalogue,
  resolveModifierSelections,
  resolveOrderLine,
  modifiersForInsert,
  parseJsonColumn,
};
