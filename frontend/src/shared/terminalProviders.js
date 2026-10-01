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
