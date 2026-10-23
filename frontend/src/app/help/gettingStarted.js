/**
 * The "Getting started" path: ordered steps from a new account to the first
 * day of trading, and the pure logic behind the progress checklist on the
 * Help page.
 *
 * Nothing here is stored on the server. A step is ticked when either
 *   - a read-only probe of existing data says so (`auto: true`), or
 *   - the person ticked it by hand (kept in this browser only).
 * A probe the signed-in role may not run (403) or that failed gives
 * `null` — "unknown", never "not done" — and the step falls back to manual.
 */

/**
 * `checks` name the probes (see `useGettingStartedProgress`) that must all be
 * true for the step to tick itself. A step with none is manual only.
 */
export const STEPS = [
  { id: 'property', guide: 'getting-started/01-property', title: 'Property details and business date', checks: ['property'], problems: 'common-problems/timezone-and-business-date' },
  { id: 'rooms-and-rates', guide: 'getting-started/02-rooms-and-rates', title: 'Room types, rooms and rates', checks: ['roomTypes', 'rooms', 'rateCodes'], problems: 'common-problems/cannot-book-a-room' },
  { id: 'taxes', guide: 'getting-started/03-taxes-and-service-charge', title: 'Taxes and service charge', checks: ['taxes'], problems: 'common-problems/tax-missing-or-wrong' },
  { id: 'payments', guide: 'getting-started/04-payments', title: 'Payment methods and the online payout account', checks: ['payoutAccount'], problems: 'common-problems/online-payments-do-not-start' },
  { id: 'pos', guide: 'getting-started/05-pos', title: 'POS outlets, menu, terminals and QR codes', checks: ['outlets', 'terminals', 'menuItems'], problems: 'common-problems/register-will-not-sell' },
  { id: 'staff', guide: 'getting-started/06-staff-and-approvals', title: 'Staff, roles and approval PINs', checks: ['staff', 'approvalPin'], problems: 'common-problems/approval-pin-and-refunds' },
  { id: 'first-test', guide: 'getting-started/07-first-test-day', title: 'A first test booking, check-in, charge, payment and check-out', checks: [], problems: 'common-problems/cannot-book-a-room' },
  { id: 'daily-routine', guide: 'getting-started/08-daily-routine', title: 'The daily routine', checks: [], problems: 'common-problems/night-audit-will-not-run' },
  { id: 'contact', guide: 'getting-started/09-who-to-contact', title: 'Who to contact', checks: [], problems: null },
];

/**
 * @param {Record<string, boolean|null|undefined>} probes  probe name → true / false / null (unknown)
 * @returns {'done'|'todo'|'unknown'|'manual'} what the data says about one step:
 *   `manual` = nothing can be checked automatically; `unknown` = some check
 *   could not be read (and none was false).
 */
export function autoStatus(step, probes) {
  if (step.checks.length === 0) return 'manual';
  const values = step.checks.map((name) => probes?.[name] ?? null);
  if (values.includes(false)) return 'todo';
  if (values.includes(null)) return 'unknown';
  return 'done';
}

/**
 * Combines the data with the person's own ticks.
 * @param {Record<string, boolean|null|undefined>} probes
 * @param {Record<string, boolean>} manual  step id → ticked by hand
 */
export function computeProgress(probes, manual = {}) {
  const steps = STEPS.map((step) => {
    const auto = autoStatus(step, probes);
    const ticked = Boolean(manual[step.id]);
    return { ...step, auto, ticked, done: auto === 'done' || ticked };
  });
  const doneCount = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done) ?? null;
  return { steps, doneCount, total: steps.length, next, complete: doneCount === steps.length };
}

// --- manual ticks, kept in this browser only --------------------------------

const STORAGE_PREFIX = 'lodgekeep.gettingStarted.v1';

/** Per user and property, so one shared device keeps separate lists. */
export function storageKey(userId, propertyId) {
  return `${STORAGE_PREFIX}:${userId ?? 'anon'}:${propertyId ?? 'none'}`;
}

export function loadManualTicks(key, storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const known = new Set(STEPS.map((step) => step.id));
    return Object.fromEntries(Object.entries(parsed).filter(([id, value]) => known.has(id) && value === true));
  } catch {
    return {};
  }
}

export function saveManualTicks(key, ticks, storage = globalThis.localStorage) {
  try {
    storage.setItem(key, JSON.stringify(ticks));
  } catch {
    // Blocked storage: the tick still works for this visit.
  }
}

// --- reading the probes ------------------------------------------------------

/** A list response with at least one entry → true, an empty one → false, anything else → unknown. */
export function hasAny(value) {
  return Array.isArray(value) ? value.length > 0 : null;
}

/** Turns a settled probe into true/false/null (a rejection is unknown, never "not done"). */
export function settle(result, read) {
  if (result.status !== 'fulfilled') return null;
  try {
    return read(result.value);
  } catch {
    return null;
  }
}

/**
 * Builds the probe map from the settled read-only calls.
 * @param {{progress, subaccount, outlets, terminals, menuItems, approvers}} results  `Promise.allSettled` results
 */
export function buildProbes(results) {
  const stepComplete = (key) => (data) => {
    const step = data.steps.find((candidate) => candidate.key === key);
    return step ? Boolean(step.complete) : null;
  };
  return {
    property: settle(results.progress, stepComplete('property')),
    roomTypes: settle(results.progress, stepComplete('room-types')),
    rooms: settle(results.progress, stepComplete('rooms')),
    rateCodes: settle(results.progress, stepComplete('rate-codes')),
    taxes: settle(results.progress, stepComplete('taxes')),
    staff: settle(results.progress, stepComplete('users')),
    payoutAccount: settle(results.subaccount, (data) => data != null),
    outlets: settle(results.outlets, hasAny),
    terminals: settle(results.terminals, hasAny),
    menuItems: settle(results.menuItems, hasAny),
    approvalPin: settle(results.approvers, (data) => (Array.isArray(data) ? data.some((approver) => approver.hasPin) : null)),
  };
}
