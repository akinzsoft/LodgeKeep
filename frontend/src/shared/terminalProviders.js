/**
 * Card terminals a hotel already owns (Moniepoint, Opay, a bank POS, ...).
 * "Card (external terminal)" records a sale taken on one of them: Lodgekeep
 * has no integration with the hardware, so the provider is only a label, and
 * optional on every sale. Values match the backend's `TERMINAL_PROVIDERS`
 * (`pos/service.js`); `other` covers any terminal not listed.
 */
export const TERMINAL_PROVIDERS = [
  { value: 'moniepoint', label: 'Moniepoint' },
  { value: 'opay', label: 'Opay' },
  { value: 'gtbank', label: 'GTBank' },
  { value: 'other', label: 'Other' },
];

export const EXTERNAL_TERMINAL_LABEL = 'Card (external terminal)';

const LABELS = Object.fromEntries(TERMINAL_PROVIDERS.map((p) => [p.value, p.label]));

/** A provider's display name; sales that gave none read "Provider not given". */
export function terminalProviderLabel(value) {
  if (!value) return 'Provider not given';
  return LABELS[value] ?? value;
}

/** Providers that can hold a recorded account (`other` has no single account). Matches the backend's `ACCOUNT_PROVIDERS`. */
export const ACCOUNT_PROVIDERS = TERMINAL_PROVIDERS.filter((p) => p.value !== 'other');

/** "Bar GTB ····6789", "····6789" or null when no account was recorded. Only the last 4 digits ever reach a report. */
export function terminalAccountText(label, last4) {
  if (!last4 && !label) return null;
  const masked = last4 ? `····${last4}` : '';
  return [label, masked].filter(Boolean).join(' ');
}
