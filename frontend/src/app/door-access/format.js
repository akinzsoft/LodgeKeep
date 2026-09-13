/**
 * Door access display helpers. Every door event is stored as a UTC instant;
 * staff read it in the PROPERTY's timezone (the same wall-clock time the lock
 * log itself recorded), never the browser's own zone.
 */

export const RULE_LABELS = {
  unsold_occupancy: 'Unsold occupancy',
  post_checkout_access: 'Post-checkout access',
};

export const ADAPTER_LABELS = {
  none: 'None',
  hiread_prousb: 'HiRead ProUSB',
  generic_csv: 'Other lock (spreadsheet export)',
};

/** DESIGN_SYSTEM.md §1: status and severity are always a labelled pill. */
export const SEVERITY_TONE = { critical: 'danger', warning: 'warning', info: 'neutral' };
export const STATUS_TONE = { open: 'danger', acknowledged: 'warning', resolved: 'success' };

/** "acknowledged" → "Acknowledged" for pill labels. */
export function capitalize(text) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

export function formatInZone(value, timeZone) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString('en-GB', {
      timeZone: timeZone || undefined,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toLocaleString('en-GB');
  }
}

/** Whole days between an event and now — the "retrospective, occurred N days ago" badge. */
export function daysAgo(value, now = new Date()) {
  const ms = now.getTime() - new Date(value).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export function describeAge(value, now = new Date()) {
  const days = daysAgo(value, now);
  if (days === 0) return 'Retrospective — occurred today';
  return `Retrospective — occurred ${days} day${days === 1 ? '' : 's'} ago`;
}
