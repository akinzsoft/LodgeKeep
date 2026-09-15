import { formatMoney } from '../../shared/format/money.jsx';

/**
 * Plain-language wording for every staff notification type (gap closure:
 * staff notifications). One place, shared by the bell dropdown and the
 * on-screen QR order card, so the two never describe the same event
 * differently. Pure — directly unit-tested.
 *
 * An unrecognised type falls back to its raw type string rather than
 * crashing, so a backend that adds a type ahead of a frontend deploy still
 * renders something.
 */

/** MySQL JSON columns can arrive already parsed or as a raw string. */
export function parsePayload(notification) {
  const raw = notification?.payload;
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** "5.000" -> "5", "2.500" -> "2.5" — quantities only, never money. */
function formatQuantity(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function money(amount, currency) {
  if (amount === null || amount === undefined || !currency) return null;
  return formatMoney(amount, currency);
}

/** "2× Chapman, 1× Coke" — the first few lines, then "+N more". */
export function summarizeItems(items, limit = 3) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const shown = items.slice(0, limit).map((item) => `${item.quantity}× ${item.name}`);
  const rest = items.length - limit;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

function join(...parts) {
  return parts.filter(Boolean).join(' · ');
}

/**
 * @param {{type: string, payload: object|string}} notification
 * @returns {{title: string, detail: string}}
 */
export function describeNotification(notification) {
  const p = parsePayload(notification);
  const guest = p.guestName || 'Guest';
  const table = p.tableLabel || 'Walk-up order';

  switch (notification.type) {
    case 'qr_ordering.guest_order_placed':
      return {
        title: `New QR order — ${table}`,
        detail: join(`${p.guestName || 'A guest'}: ${summarizeItems(p.items) || 'items'}`, money(p.total, p.currency)),
      };
    case 'qr_ordering.guest_order_rejected':
      return { title: `QR order rejected — ${table}`, detail: join(p.guestName, p.reason) };
    case 'pos.order_settled':
      return { title: `POS order settled — ${table}`, detail: money(p.total, p.currency) ?? '' };
    case 'pos.settlement_voided':
      return { title: `POS settlement voided — ${table}`, detail: join(money(p.total, p.currency), p.reason) };
    case 'stock.reorder_level_reached':
      return {
        title: `Low stock: ${p.name ?? 'stock item'}`,
        detail: `${formatQuantity(p.quantity)} ${p.unit ?? ''} left, reorder level ${formatQuantity(p.reorderLevel)}`.replace(/\s+/g, ' ').trim(),
      };
    case 'stock.out_of_stock':
      return { title: `Out of stock: ${p.name ?? 'stock item'}`, detail: 'Menu items that use it are now unavailable.' };
    case 'reservation.created':
      return { title: `New booking — ${guest}`, detail: join(`${p.arrivalDate} to ${p.departureDate}`, p.confirmationNumber) };
    case 'reservation.cancelled':
      return { title: `Booking cancelled — ${guest}`, detail: join(`${p.arrivalDate} to ${p.departureDate}`, p.confirmationNumber) };
    case 'guest.checked_in':
      return { title: `Checked in — ${guest}`, detail: p.roomNumber ? `Room ${p.roomNumber}` : '' };
    case 'guest.checked_out':
      return { title: `Checked out — ${guest}`, detail: p.confirmationNumber ?? '' };
    case 'front_desk.departing_balance_outstanding':
      return {
        title: `Departing today with a balance — ${guest}`,
        detail: join(p.roomNumber ? `Room ${p.roomNumber}` : null, money(p.balance, p.currency) ? `owes ${money(p.balance, p.currency)}` : null),
      };
    case 'room.became_dirty':
      return {
        title: `Room ${p.roomNumber ?? ''} needs cleaning`.replace(/\s+/g, ' '),
        detail: p.reason === 'room_move' ? 'Vacated by a room move.' : 'Vacated at check-out.',
      };
    case 'housekeeping.discrepancy_raised':
      return {
        title: `Room ${p.roomNumber ?? p.roomId ?? ''} status discrepancy`.replace(/\s+/g, ' '),
        detail: 'Housekeeping and the front desk disagree on occupancy.',
      };
    case 'door_access.critical_alert_raised': {
      const rule = p.rule === 'post_checkout_access' ? 'post-checkout access' : 'unsold occupancy';
      return {
        title: `Door access alert — Room ${p.roomNumber ?? '?'}`,
        detail: `${rule}, found in an uploaded lock log (retrospective).`,
      };
    }
    case 'night_audit.completed':
      return {
        title: `Night audit closed ${p.businessDate ?? 'the day'}`,
        detail: p.nextBusinessDate ? `Business date is now ${p.nextBusinessDate}.` : '',
      };
    case 'night_audit.failed':
      return p.reason === 'blocked_by_discrepancy'
        ? {
            title: `Night audit blocked — ${p.businessDate ?? 'today'}`,
            detail: `${p.conditionCount ?? 'An'} unresolved housekeeping discrepanc${p.conditionCount === 1 ? 'y is' : 'ies are'} blocking it.`,
          }
        : { title: `Night audit failed — ${p.businessDate ?? 'today'}`, detail: p.message ?? '' };
    case 'night_audit.overdue':
      return {
        title: `Night audit overdue — ${p.businessDate ?? 'a business date'}`,
        detail: p.todayInPropertyTz ? `It's already ${p.todayInPropertyTz} and that date is still open.` : '',
      };
    default:
      return { title: notification.type, detail: '' };
  }
}

/** Which screen a notification opens when clicked — a sidebar nav key. */
export function notificationTarget(type) {
  if (type.startsWith('qr_ordering.') || type.startsWith('pos.') || type.startsWith('stock.')) return 'pos';
  if (type.startsWith('reservation.') || type.startsWith('guest.') || type.startsWith('front_desk.')) return 'booking';
  if (type.startsWith('room.') || type.startsWith('housekeeping.')) return 'housekeeping';
  if (type.startsWith('door_access.')) return 'door_access';
  if (type.startsWith('night_audit.')) return 'night_audit';
  return null;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(isoString, now = Date.now()) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
