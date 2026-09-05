'use strict';

/**
 * Setup module service — PLAN.md Phase 1's business logic: property
 * creation, room types, room inventory (with bulk entry), rate codes and
 * the rate calendar, and effective-dated taxes.
 *
 * Every database access goes through `scopedDb()`, never raw knex — the
 * same rule every other module follows.
 */

const { scopedDb } = require('../../db');
const { DuplicateEntryError, InvalidBulkRangeError, TaxEffectiveDateOverlapError } = require('./errors');

/** Wraps a write that can hit a UNIQUE constraint, mapping MySQL's raw error to a real AppError (see errors.js's own note on why this exists). */
async function withDuplicateMapping(resource, message, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new DuplicateEntryError(resource, message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------

/**
 * Creates a property, including its opening business date — PLAN.md Phase 1:
 * "Property record, timezone, currency, business date initialisation."
 *
 * No `requirePermission` check gates this at the route layer (see
 * `routes.js`'s own note) — creating a tenant's very first property happens
 * before any `user_property_access` grant can exist to check a role
 * against, which is exactly the case `requirePermission` cannot handle
 * (SECURITY.md §3's every check is "at the active property," and there is
 * none yet). Real tenant/first-admin provisioning is Phase 5 (SaaS platform)
 * territory; until it exists, any authenticated staff member of the tenant
 * may create a property, which is safe today only because Phase 0 has no
 * self-service signup — every `users` row so far comes from the dev seed
 * script or a fixture, not a stranger.
 */
async function createProperty({ context, name, slug, timezone, baseCurrency, address, businessDate }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'properties',
    `A property with slug "${slug}" already exists for this tenant.`,
    async () => {
      const [id] = await db.table('properties').insert({
        name,
        slug,
        timezone,
        base_currency: baseCurrency,
        address: address ?? null,
        current_business_date: businessDate ?? null,
      });
      return getProperty({ context, id });
    }
  );
}

async function updateProperty({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('properties').where({ id }).update(changes);
  return getProperty({ context, id });
}

async function getProperty({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('properties').where({ id }).first();
}

/** Tenant-wide — deliberately not pinned to the active property (there may be none yet), matching the property switcher's own "which properties may I work at" query. */
async function listProperties({ context }) {
  const db = scopedDb().for(context);
  return db.acrossProperties().table('properties').where({ status: 'active' }).orderBy('name');
}

// ---------------------------------------------------------------------
// Room types
// ---------------------------------------------------------------------

async function createRoomType({ context, code, name, description, defaultOccupancy, baseRate, photos }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'room_types',
    `A room type with code "${code}" already exists at this property.`,
    async () => {
      const [id] = await db.table('room_types').insert({
        code,
        name,
        description: description ?? null,
        default_occupancy: defaultOccupancy,
        base_rate: baseRate,
        photos: photos ?? null,
      });
      return getRoomType({ context, id });
    }
  );
}

async function updateRoomType({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('room_types').where({ id }).update(changes);
  return getRoomType({ context, id });
}

async function archiveRoomType({ context, id }) {
  return updateRoomType({ context, id, changes: { status: 'archived' } });
}

async function getRoomType({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('room_types').where({ id }).first();
}

async function listRoomTypes({ context }) {
  const db = scopedDb().for(context);
  return db.table('room_types').where({ status: 'active' }).orderBy('code');
}

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------

async function createRoom({ context, roomNumber, floor, roomTypeId, connectingRoomId }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'rooms',
    `Room "${roomNumber}" already exists at this property.`,
    async () => {
      const [id] = await db.table('rooms').insert({
        room_number: roomNumber,
        floor: floor ?? null,
        room_type_id: roomTypeId,
        connecting_room_id: connectingRoomId ?? null,
      });
      return getRoom({ context, id });
    }
  );
}

async function updateRoom({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('rooms').where({ id }).update(changes);
  return getRoom({ context, id });
}

async function getRoom({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('rooms').where({ id }).first();
}

async function listRooms({ context }) {
  const db = scopedDb().for(context);
  return db.table('rooms').whereNot({ status: 'archived' }).orderBy('room_number');
}

/**
 * Expands an inclusive numeric room-number range into individual strings,
 * preserving the wider input's zero-padding width — "01".."10" stays
 * two-digit, "101".."160" stays three-digit.
 *
 * Exported for direct unit testing (TESTING.md SET-1: "range 101–160 -> 60
 * rooms, correct type/floor") without needing a real database.
 */
function expandRoomNumberRange(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || !/^\d+$/.test(from) || !/^\d+$/.test(to)) {
    throw new InvalidBulkRangeError('"from" and "to" must both be whole numbers, e.g. "101" and "160".');
  }
  const width = Math.max(from.length, to.length);
  const start = Number(from);
  const end = Number(to);
  if (end < start) {
    throw new InvalidBulkRangeError('"to" must not be earlier than "from".');
  }
  if (end - start + 1 > 1000) {
    throw new InvalidBulkRangeError('A single bulk range may not create more than 1000 rooms at once.');
  }
  const numbers = [];
  for (let n = start; n <= end; n += 1) {
    numbers.push(String(n).padStart(width, '0'));
  }
  return numbers;
}

/**
 * PLAN.md Phase 1: "bulk entry — hand-keying 60 rooms is a real onboarding
 * failure." Creates one row per number in the range, all in one insert, all
 * against the same room type and floor.
 *
 * A number that collides with an existing room (or is repeated within the
 * batch) fails the whole call with a single `DuplicateEntryError`
 * (TESTING.md SET-2's "rejected" — nothing partially commits, since the
 * insert is one statement) rather than silently skipping the bad numbers.
 */
async function bulkCreateRooms({ context, roomTypeId, floor, from, to }) {
  const numbers = expandRoomNumberRange(from, to);
  const db = scopedDb().for(context);

  return withDuplicateMapping(
    'rooms',
    `One or more room numbers in ${from}-${to} already exist at this property.`,
    async () => {
      await db.table('rooms').insert(
        numbers.map((roomNumber) => ({
          room_number: roomNumber,
          floor: floor ?? null,
          room_type_id: roomTypeId,
        }))
      );
      return db.table('rooms').whereIn('room_number', numbers).orderBy('room_number');
    }
  );
}

// ---------------------------------------------------------------------
// Rate codes
// ---------------------------------------------------------------------

async function createRateCode({ context, code, description, baseRate, currency, validFrom, validTo }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'rate_codes',
    `A rate code "${code}" already exists at this property.`,
    async () => {
      const [id] = await db.table('rate_codes').insert({
        code,
        description: description ?? null,
        base_rate: baseRate,
        currency,
        valid_from: validFrom,
        valid_to: validTo ?? null,
      });
      return getRateCode({ context, id });
    }
  );
}

async function updateRateCode({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('rate_codes').where({ id }).update(changes);
  return getRateCode({ context, id });
}

async function archiveRateCode({ context, id }) {
  return updateRateCode({ context, id, changes: { status: 'archived' } });
}

async function getRateCode({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('rate_codes').where({ id }).first();
}

async function listRateCodes({ context }) {
  const db = scopedDb().for(context);
  return db.table('rate_codes').where({ status: 'active' }).orderBy('code');
}

// ---------------------------------------------------------------------
// Rate calendar
// ---------------------------------------------------------------------

async function setRateOverride({ context, rateCodeId, roomTypeId, stayDate, rate }) {
  const db = scopedDb().for(context);
  const existing = await db
    .table('rate_calendar')
    .where({ rate_code_id: rateCodeId, room_type_id: roomTypeId, stay_date: stayDate })
    .first();

  if (existing) {
    await db.table('rate_calendar').where({ id: existing.id }).update({ rate });
    return db.table('rate_calendar').where({ id: existing.id }).first();
  }

  const [id] = await db.table('rate_calendar').insert({
    rate_code_id: rateCodeId,
    room_type_id: roomTypeId,
    stay_date: stayDate,
    rate,
  });
  return db.table('rate_calendar').where({ id }).first();
}

async function deleteRateOverride({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('rate_calendar').where({ id }).delete();
}

async function listRateCalendar({ context, rateCodeId, roomTypeId, from, to }) {
  const db = scopedDb().for(context);
  return db
    .table('rate_calendar')
    .where({ rate_code_id: rateCodeId, room_type_id: roomTypeId })
    .whereBetween('stay_date', [from, to])
    .orderBy('stay_date');
}

/**
 * TESTING.md SET-6: "date override wins over rate-code base rate." A pure
 * read-and-resolve, not a database view or trigger, so it is directly
 * unit-testable (see the module's own tests) against a date that does and
 * does not have an override, with no need for anything beyond these two
 * already-fetched rows.
 *
 * @param {{base_rate: string}} rateCode
 * @param {{rate: string}|undefined} override  The rate_calendar row for this exact date, if any.
 * @returns {string} The resolved rate, as a DECIMAL string (ARCHITECTURE.md §1 — never a float).
 */
function resolveRate(rateCode, override) {
  return override ? override.rate : rateCode.base_rate;
}

/** Fetches whatever `resolveRate` needs for one (rate code, room type, date) and resolves it — the endpoint-facing convenience wrapper around the pure function above. */
async function resolveRateForDate({ context, rateCodeId, roomTypeId, stayDate }) {
  const db = scopedDb().for(context);
  const [rateCode, override] = await Promise.all([
    db.table('rate_codes').where({ id: rateCodeId }).first(),
    db.table('rate_calendar').where({ rate_code_id: rateCodeId, room_type_id: roomTypeId, stay_date: stayDate }).first(),
  ]);
  if (!rateCode) return null;
  return { rate: resolveRate(rateCode, override), overridden: Boolean(override) };
}

// ---------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------

/**
 * "Changing a tax rate" is never an UPDATE — it is a new effective-dated
 * row, with the version it supersedes closed out in the same transaction
 * (ARCHITECTURE.md §12.1). `effectiveFrom` must be strictly after every
 * existing version's start date for this `tax_code`; the immediately-prior
 * version (the one with no `effective_to` yet, or the latest one) gets its
 * `effective_to` set to the day before this new version starts.
 */
// ---------------------------------------------------------------------
// Market segments, booking sources, cancellation policies — PLAN.md
// Phase 1 gap closure (PRODUCT_REQUIREMENTS.md §3.19). All three are the
// identical "simple reference-data list, archive-not-delete" shape as
// room_types/rate_codes above.
// ---------------------------------------------------------------------

async function createMarketSegment({ context, code, name }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'market_segments',
    `A market segment with code "${code}" already exists at this property.`,
    async () => {
      const [id] = await db.table('market_segments').insert({ code, name });
      return getMarketSegment({ context, id });
    }
  );
}

async function updateMarketSegment({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('market_segments').where({ id }).update(changes);
  return getMarketSegment({ context, id });
}

async function archiveMarketSegment({ context, id }) {
  return updateMarketSegment({ context, id, changes: { status: 'archived' } });
}

async function getMarketSegment({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('market_segments').where({ id }).first();
}

async function listMarketSegments({ context }) {
  const db = scopedDb().for(context);
  return db.table('market_segments').where({ status: 'active' }).orderBy('code');
}

async function createBookingSource({ context, code, name }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'booking_sources',
    `A booking source with code "${code}" already exists at this property.`,
    async () => {
      const [id] = await db.table('booking_sources').insert({ code, name });
      return getBookingSource({ context, id });
    }
  );
}

async function updateBookingSource({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('booking_sources').where({ id }).update(changes);
  return getBookingSource({ context, id });
}

async function archiveBookingSource({ context, id }) {
  return updateBookingSource({ context, id, changes: { status: 'archived' } });
}

async function getBookingSource({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('booking_sources').where({ id }).first();
}

async function listBookingSources({ context }) {
  const db = scopedDb().for(context);
  return db.table('booking_sources').where({ status: 'active' }).orderBy('code');
}

async function createCancellationPolicy({ context, code, name, description, cutoffHours, feeType, feeValue }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping(
    'cancellation_policies',
    `A cancellation policy with code "${code}" already exists at this property.`,
    async () => {
      const [id] = await db.table('cancellation_policies').insert({
        code,
        name,
        description: description ?? null,
        cutoff_hours: cutoffHours ?? null,
        fee_type: feeType ?? 'none',
        fee_value: feeValue ?? null,
      });
      return getCancellationPolicy({ context, id });
    }
  );
}

async function updateCancellationPolicy({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('cancellation_policies').where({ id }).update(changes);
  return getCancellationPolicy({ context, id });
}

async function archiveCancellationPolicy({ context, id }) {
  return updateCancellationPolicy({ context, id, changes: { status: 'archived' } });
}

async function getCancellationPolicy({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('cancellation_policies').where({ id }).first();
}

async function listCancellationPolicies({ context }) {
  const db = scopedDb().for(context);
  return db.table('cancellation_policies').where({ status: 'active' }).orderBy('code');
}

// ---------------------------------------------------------------------
// Setup wizard progress — PLAN.md Phase 1 gap closure,
// PRODUCT_REQUIREMENTS.md §3.19: "Show progress and allow resuming."
//
// Deliberately computed from the real data every time, never a stored
// per-step "visited" flag — the same "read the real thing, don't invent a
// shadow state" reasoning Reporting's own daily_reports snapshot follows.
// A step is complete when the data it configures actually exists; nothing
// here can drift out of sync with reality, and resuming after leaving
// mid-wizard needs no persistence at all — the next load simply recomputes
// the same answer.
// ---------------------------------------------------------------------

/** Taxes and users are shown as wizard steps but not required to reach "operational" — a real property may legitimately configure zero taxes, and the account performing setup already counts as a user. */
const OPTIONAL_STEPS = new Set(['taxes', 'users']);

async function getSetupProgress({ context }) {
  const db = scopedDb().for(context);
  const hasProperty = Boolean(context.propertyId) && Boolean(await db.table('properties').where({ id: context.propertyId }).first('id'));

  const counts = hasProperty
    ? await Promise.all([
        db.table('room_types').where({ status: 'active' }).count(),
        db.table('rooms').count(),
        db.table('rate_codes').where({ status: 'active' }).count(),
        db.table('taxes').count(),
        db.table('user_property_access').count(),
      ])
    : [0, 0, 0, 0, 0];
  const [roomTypeCount, roomCount, rateCodeCount, taxCount, userCount] = counts;

  const steps = [
    { key: 'property', label: 'Property', complete: hasProperty },
    { key: 'room-types', label: 'Room Types', complete: hasProperty && roomTypeCount > 0 },
    { key: 'rooms', label: 'Rooms', complete: hasProperty && roomCount > 0 },
    { key: 'rate-codes', label: 'Rate Codes & Calendar', complete: hasProperty && rateCodeCount > 0 },
    { key: 'taxes', label: 'Taxes', complete: hasProperty && taxCount > 0, optional: true },
    { key: 'users', label: 'Users', complete: hasProperty && userCount > 1, optional: true },
  ];

  const operational = steps.filter((step) => !OPTIONAL_STEPS.has(step.key)).every((step) => step.complete);
  return { steps, operational };
}

async function createTaxVersion({ context, taxCode, name, rate, effectiveFrom, isInclusive, calculationMethod, priority, isCompound, roundingMethod, jurisdiction, applies_to: appliesTo }) {
  const db = scopedDb().for(context);

  return db.transaction(async (trx) => {
    const previous = await trx
      .table('taxes')
      .where({ tax_code: taxCode })
      .where('effective_from', '<', effectiveFrom)
      .orderBy('effective_from', 'desc')
      .first();

    if (previous) {
      if (previous.effective_to && previous.effective_to >= effectiveFrom) {
        throw new TaxEffectiveDateOverlapError(taxCode);
      }
      const dayBefore = new Date(effectiveFrom);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      await trx
        .table('taxes')
        .where({ id: previous.id })
        .update({ effective_to: dayBefore.toISOString().slice(0, 10) });
    }

    return withDuplicateMapping(
      'taxes',
      `A version of tax "${taxCode}" already starts on ${effectiveFrom}.`,
      async () => {
        const [id] = await trx.table('taxes').insert({
          tax_code: taxCode,
          name,
          rate,
          effective_from: effectiveFrom,
          is_inclusive: isInclusive,
          calculation_method: calculationMethod,
          priority: priority ?? 0,
          is_compound: isCompound ?? false,
          rounding_method: roundingMethod ?? 'half_up',
          jurisdiction: jurisdiction ?? null,
          applies_to: appliesTo ?? 'all',
        });
        return trx.table('taxes').where({ id }).first();
      }
    );
  });
}

/** Every version of every tax the property has ever had, most recent first — the Taxes screen shows current AND historical versions (PRODUCT_REQUIREMENTS.md §3.19: "Show ... does not alter historical folios", which a user should be able to see for themselves). */
async function listTaxes({ context }) {
  const db = scopedDb().for(context);
  return db.table('taxes').orderBy(['tax_code', { column: 'effective_from', order: 'desc' }]);
}

/**
 * ARCHITECTURE.md §12.1's historical-reproducibility rule, made directly
 * testable without Phase 2's folio schema: "always calculating against the
 * tax version effective on the charge's business_date." A pure resolution
 * over already-fetched rows — see the module's own tests for the exact
 * cases (a date before any version, a date exactly on a boundary, a date
 * after a rate change still resolving the OLD version for an OLD date).
 *
 * @param {Array<{effective_from: string, effective_to: string|null}>} versions  Every version of one tax_code, any order.
 * @param {string} businessDate  'YYYY-MM-DD'.
 * @returns {object|null} The version effective on that date, or null if none covers it.
 */
function resolveEffectiveTax(versions, businessDate) {
  return (
    versions.find(
      (version) =>
        version.effective_from <= businessDate && (!version.effective_to || version.effective_to >= businessDate)
    ) ?? null
  );
}

/** Fetches every version of one tax_code and resolves the one effective on a date — the endpoint-facing wrapper around the pure function above. */
async function resolveTaxForDate({ context, taxCode, businessDate }) {
  const db = scopedDb().for(context);
  const versions = await db.table('taxes').where({ tax_code: taxCode });
  return resolveEffectiveTax(versions, businessDate);
}

module.exports = {
  createProperty,
  updateProperty,
  getProperty,
  listProperties,
  createRoomType,
  updateRoomType,
  archiveRoomType,
  getRoomType,
  listRoomTypes,
  createRoom,
  updateRoom,
  getRoom,
  listRooms,
  expandRoomNumberRange,
  bulkCreateRooms,
  createRateCode,
  updateRateCode,
  archiveRateCode,
  getRateCode,
  listRateCodes,
  setRateOverride,
  deleteRateOverride,
  listRateCalendar,
  resolveRate,
  resolveRateForDate,
  createTaxVersion,
  listTaxes,
  resolveEffectiveTax,
  resolveTaxForDate,
  createMarketSegment,
  updateMarketSegment,
  archiveMarketSegment,
  getMarketSegment,
  listMarketSegments,
  createBookingSource,
  updateBookingSource,
  archiveBookingSource,
  getBookingSource,
  listBookingSources,
  createCancellationPolicy,
  updateCancellationPolicy,
  archiveCancellationPolicy,
  getCancellationPolicy,
  listCancellationPolicies,
  getSetupProgress,
};
