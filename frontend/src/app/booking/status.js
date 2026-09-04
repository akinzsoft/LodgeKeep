/**
 * Reservation status -> StatusPill tone mapping — owned by this module, per
 * StatusPill's own doc ("each feature module maps its own status strings to
 * a tone ... not invented ahead of those modules"). ARCHITECTURE.md §11's
 * state machine is the source of the status values themselves.
 */
const TONES = {
  waitlisted: 'warning',
  tentative: 'info',
  confirmed: 'success',
  checked_in: 'success',
  checked_out: 'neutral',
  cancelled: 'neutral',
  no_show: 'danger',
  expired: 'neutral',
};

const LABELS = {
  waitlisted: 'Waitlisted',
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired',
};

export function statusTone(status) {
  return TONES[status] ?? 'neutral';
}

export function statusLabel(status) {
  return LABELS[status] ?? status;
}
