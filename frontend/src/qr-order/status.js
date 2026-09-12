/**
 * Guest-order status/payment-status -> StatusPill tone mapping — owned by
 * this module, matching `StatusPill`'s own doc ("each feature module maps
 * its own status strings to a tone"). Shared between the guest-facing app
 * (`qr-order/screens/*`) and the staff-facing queue
 * (`app/pos/GuestOrdersTab.jsx`) so both sides of one guest order always
 * render the identical vocabulary — the same "one source of truth for a
 * status word" reasoning `app/booking/status.js` already established for
 * reservations, reused across the portal and staff apps.
 *
 * Values match `pos_guest_orders`' own migration header exactly:
 * `status`: awaiting_payment -> received -> preparing -> on_the_way, or
 * rejected/auto_rejected at any point before `preparing`.
 * `payment_status`: unpaid -> paid|charged_to_room -> refunded.
 */
const STATUS_TONES = {
  awaiting_payment: 'warning',
  received: 'info',
  preparing: 'warning',
  on_the_way: 'success',
  rejected: 'danger',
  auto_rejected: 'danger',
};

const STATUS_LABELS = {
  awaiting_payment: 'Awaiting payment',
  received: 'Received',
  preparing: 'Preparing',
  on_the_way: 'On the way',
  rejected: 'Rejected',
  auto_rejected: 'Auto-rejected',
};

const PAYMENT_STATUS_TONES = {
  unpaid: 'warning',
  paid: 'success',
  charged_to_room: 'success',
  refunded: 'neutral',
};

const PAYMENT_STATUS_LABELS = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  charged_to_room: 'Charged to room',
  refunded: 'Refunded',
};

export function guestOrderStatusTone(status) {
  return STATUS_TONES[status] ?? 'neutral';
}

export function guestOrderStatusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function guestOrderPaymentTone(paymentStatus) {
  return PAYMENT_STATUS_TONES[paymentStatus] ?? 'neutral';
}

export function guestOrderPaymentLabel(paymentStatus) {
  return PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus;
}

/** Still polling-worthy — payment may complete, staff may act, an auto-reject may fire. `on_the_way`/`rejected`/`auto_rejected` are all stable end states no further staff action changes (see `qr-ordering/service.js`'s own `resolveEffectiveGuestOrderStatus` header: past `received`, auto-reject can never fire again). */
export function isGuestOrderStillMoving(status) {
  return status === 'awaiting_payment' || status === 'received' || status === 'preparing';
}
