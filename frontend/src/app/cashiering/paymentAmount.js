/**
 * The payment Amount field (Cashiering "Capture a payment" and the booking screen's Payment card). It defaults to the
 * balance owed but may be changed: paying more than is owed is a DEPOSIT and leaves a credit on the folio. The server
 * validates the same rules (`backend/src/shared/payment-amount.js`) and is the real guard; this only saves a round
 * trip and explains the credit.
 */
import { compareMoney, subtractMoney } from '../../shared/money.js';

/** Mirrors the server's default ceiling (MAX_PAYMENT_AMOUNT). The server's own value is the real limit. */
export const MAX_PAYMENT_AMOUNT = '10000000.00';

/** What the field starts as: the balance when something is owed, otherwise empty (a deposit has no default). */
export function defaultPaymentAmount(balance) {
  if (balance == null) return '';
  const text = String(balance).trim();
  return /^\d+(\.\d{1,2})?$/.test(text) && compareMoney(text, '0.00') > 0 ? text : '';
}

/** A reason the typed amount cannot be sent, or `null` when it can. */
export function paymentAmountProblem(text) {
  const value = String(text ?? '').trim();
  if (!value) return 'Enter an amount.';
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return 'Enter a positive amount with at most 2 decimal places.';
  if (compareMoney(value, '0.00') <= 0) return 'The amount must be greater than zero.';
  if (compareMoney(value, MAX_PAYMENT_AMOUNT) > 0) return `The amount cannot be more than ${MAX_PAYMENT_AMOUNT}.`;
  return null;
}

/**
 * The part of a valid amount that is more than the folio owes, i.e. what becomes (more) credit. `null` when the
 * amount is not above the balance. A folio already in credit (or settled) owes nothing, so all of it is deposit.
 */
export function depositPortion(text, balance) {
  const value = String(text ?? '').trim();
  if (paymentAmountProblem(value) || balance == null) return null;
  const owed = compareMoney(String(balance), '0.00') > 0 ? String(balance) : '0.00';
  return compareMoney(value, owed) > 0 ? subtractMoney(value, owed) : null;
}
