/**
 * Which of the property's rate codes are actually offerable for a given
 * stay — user-reported gap: the Booking screen's rate code dropdown showed
 * every active rate code regardless of the dates being booked, requiring a
 * manual pick every time.
 *
 * Checked against the real schema before building this (backend/migrations/
 * 20260905092000_create_rate_codes.js, 20260905093000_create_rate_calendar.js)
 * rather than assumed: a rate code is NOT scoped to a room type at all — it
 * is a property-wide plan (`rate_codes`, PROPERTY_SCOPED), and `rate_calendar`
 * only carries per-(rate code, room type, date) PRICE OVERRIDES, never a
 * membership/eligibility relationship. An active rate code with no override
 * row for a given room type still applies to it, at `rate_codes.base_rate`.
 * So there is no room-type filter to apply here — every active rate code is
 * valid for every room type, and `reservations/service.js`'s own
 * `createReservation` confirms this: it checks `rate_code_id` for existence
 * only, never against `room_type_id`. Filtering by room type would need a
 * real schema change (a rate-code/room-type membership table), not asked
 * for here.
 *
 * The one real, schema-backed date-range filter that DOES exist is the rate
 * code's own `valid_from`/`valid_to` — when a plan like "Summer Promo 2026"
 * is offerable at all, independent of room type. A reservation always
 * quotes ONE rate code for its entire stay (no per-night rate-code switch),
 * so a code only counts as valid for a search when its window covers every
 * night of the stay, not merely the arrival date.
 *
 * The backend does not itself enforce this window on `createReservation` —
 * a stricter, real fix there is a separate, backend-side gap, not this
 * screen's own filtering. So a code lapsing outside its `valid_to`/`valid_from`
 * is a UI convenience only: if narrowing to date-valid codes would leave
 * NOTHING selectable (e.g. every code is a narrowly time-boxed promo and
 * none covers this particular search), the full list is offered instead of
 * blocking a booking the backend would still accept — "filter," never "hide
 * the only way to book."
 *
 * Gap closure (user-reported, with a screenshot, after the above shipped):
 * "put only the price of the room type selected" — every rate code being
 * genuinely valid for every room type (above) is real, but it's not what a
 * hotel actually wants shown. `room_types.primary_rate_code_id` (new
 * migration, confirmed with the user via AskUserQuestion) is a real,
 * schema-backed "this room type's own rate," resolved by
 * `resolvePrimaryRateCodeForStay` below.
 */

/** UTC-safe, matching `TapeChartTab.jsx`'s own local `addDays`. */
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{valid_from: string, valid_to: string|null}} rateCode
 * @param {string} arrivalDate    'YYYY-MM-DD'
 * @param {string} departureDate  'YYYY-MM-DD' (checkout day — the last
 *   NIGHT of the stay is departureDate minus one day)
 * @returns {boolean}
 */
export function isRateCodeValidForStay(rateCode, arrivalDate, departureDate) {
  if (!arrivalDate || !departureDate) return true;
  const lastNight = addDays(departureDate, -1);
  const coversStart = rateCode.valid_from <= arrivalDate;
  const coversEnd = rateCode.valid_to == null || rateCode.valid_to >= lastNight;
  return coversStart && coversEnd;
}

/**
 * Narrows `rateCodes` to the ones valid for the whole stay — see this
 * file's own header for the room-type finding and the empty-result
 * fallback. Alphabetical within the result, matching `listRateCodes`'s own
 * `orderBy('code')`.
 */
export function filterRateCodesForStay(rateCodes, arrivalDate, departureDate) {
  const all = [...(rateCodes ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const valid = all.filter((rc) => isRateCodeValidForStay(rc, arrivalDate, departureDate));
  return valid.length > 0 ? valid : all;
}

/**
 * The selected room type's OWN configured rate code, for this exact stay —
 * `null` when the room type has none configured (`primary_rate_code_id`
 * is nullable — true for every room type until someone sets one in Setup),
 * when it references a rate code that's no longer in the active list
 * (e.g. archived since), or when it's genuinely lapsed/not-yet-open for
 * these particular dates (`isRateCodeValidForStay`) — "no data to prefer,
 * don't invent one," never a stale or invalid code forced through.
 *
 * @param {{primary_rate_code_id: string|number|null}|null|undefined} roomType
 * @param {Array<object>} rateCodes  The full active list, unfiltered.
 * @param {string} arrivalDate
 * @param {string} departureDate
 */
export function resolvePrimaryRateCodeForStay(roomType, rateCodes, arrivalDate, departureDate) {
  if (!roomType?.primary_rate_code_id) return null;
  const candidate = (rateCodes ?? []).find((rc) => String(rc.id) === String(roomType.primary_rate_code_id));
  if (!candidate) return null;
  return isRateCodeValidForStay(candidate, arrivalDate, departureDate) ? candidate : null;
}
