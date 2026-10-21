'use strict';

/**
 * Who a piece of outgoing mail speaks for, which decides its Reply-To.
 *
 * - `guest`: mail sent on behalf of a hotel to its guests and customers (booking
 *   confirmations, check-in/out notes, guest receipts and codes, invoices to a company).
 *   Replies belong to the hotel, so the hotel's own contact stays the Reply-To.
 * - `platform`: everything else (staff sign-in codes, password resets, invitations, the
 *   subscription and trial notices, billing, purge warnings, internal alerts). Replies go
 *   to the platform's shared address, never back to the person the mail was sent to.
 *
 * An event type that is not listed is `platform`: the safe side, since it can never put a
 * recipient's own address in their Reply-To.
 */

const { isSingleEmailAddress } = require('./smtp-guard');

const GUEST_FACING_EVENT_TYPES = new Set([
  'reservation.confirmed',
  'reservation.cancelled',
  'guest.checked_in',
  'guest.checked_out',
  'guest.password_reset_requested',
  'pos.room_charge_otp_requested',
  'pos.guest_order_receipt',
  'ar.invoice_generated',
  'ar.payment_received',
]);

const DEFAULT_PLATFORM_REPLY_TO = 'info@planmsys.com';

function audienceForEvent(eventType) {
  return GUEST_FACING_EVENT_TYPES.has(eventType) ? 'guest' : 'platform';
}

/**
 * The Reply-To for platform mail: PLATFORM_REPLY_TO when set, info@planmsys.com when it is
 * not set at all, and none when it is set to an empty or invalid value.
 */
function platformReplyTo(env = process.env) {
  const raw = env.PLATFORM_REPLY_TO;
  const value = raw === undefined ? DEFAULT_PLATFORM_REPLY_TO : String(raw).trim();
  return value && isSingleEmailAddress(value) ? value : null;
}

module.exports = { GUEST_FACING_EVENT_TYPES, DEFAULT_PLATFORM_REPLY_TO, audienceForEvent, platformReplyTo };
