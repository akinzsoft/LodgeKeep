/** The manager approval PIN: exactly 6 digits (backend `src/modules/approvals`). */
export const PIN_LENGTH = 6;

/** What a PIN field keeps of what was typed: digits only, at most 6. */
export function digitsOnly(value) {
  return value.replace(/\D/g, '').slice(0, PIN_LENGTH);
}

export function isCompletePin(pin) {
  return pin.length === PIN_LENGTH && /^\d+$/.test(pin);
}

/** The attributes every PIN input shares: masked, numeric keypad on a tablet, never autofilled. */
export const PIN_INPUT_PROPS = { type: 'password', inputMode: 'numeric', autoComplete: 'off', maxLength: PIN_LENGTH };
