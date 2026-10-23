/**
 * The IANA timezones a property may use. The server accepts only real IANA
 * names (a free-text "Lagos" breaks night-audit date maths), so forms offer
 * this list instead of a text box. Mirrors the backend's `Intl` check.
 */
export const DEFAULT_TIMEZONE = 'Africa/Lagos';

const FALLBACK = ['Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'America/New_York', 'Asia/Dubai', 'UTC'];

export function listTimezones() {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    if (zones.length) return zones;
  } catch {
    // very old runtime: fall through
  }
  return FALLBACK;
}

export function isValidTimezone(value) {
  return listTimezones().includes(value);
}
