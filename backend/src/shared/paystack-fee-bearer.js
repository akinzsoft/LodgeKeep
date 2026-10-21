'use strict';

/**
 * Who pays Paystack's transaction fee on a split (subaccount) payment.
 * `PAYSTACK_FEE_BEARER`:
 *   - `subaccount` (default): the hotel's subaccount bears it, so the platform account is not charged on guest card payments.
 *   - `account`: the main (platform) account bears it.
 * Sent to Paystack as `bearer` on /transaction/initialize, only when a subaccount is attached. `transaction_charge` is never sent.
 * Read fresh on every call, like the other env-driven settings; checked once at boot by `validateStartupConfig`.
 */

const FEE_BEARERS = ['subaccount', 'account'];
const DEFAULT_FEE_BEARER = 'subaccount';

function feeBearer(env = process.env) {
  const raw = env.PAYSTACK_FEE_BEARER;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_FEE_BEARER;
  const value = String(raw).trim().toLowerCase();
  if (!FEE_BEARERS.includes(value)) {
    throw new Error(`PAYSTACK_FEE_BEARER must be one of: ${FEE_BEARERS.join(', ')} (got "${raw}").`);
  }
  return value;
}

/** One boot line with the effective setting (no secrets). */
function logFeeBearer(env = process.env, log = console.log) {
  const line = `[paystack] fee bearer for split payments: ${feeBearer(env)}`;
  log(line);
  return line;
}

module.exports = { FEE_BEARERS, DEFAULT_FEE_BEARER, feeBearer, logFeeBearer };
