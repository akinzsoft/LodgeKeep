'use strict';

/**
 * Repairs `properties.timezone` values that are not real IANA zones. Free-text
 * values such as "Lagos", "LAGOS", "Africa" or "Africa/Asaba" make every
 * `Intl`-based computation throw (the night-audit overdue sweep logs a
 * RangeError per property and never alerts; the premature-run guard skips
 * itself). New writes are validated now; this fixes the rows already stored.
 *
 *   node scripts/fix-property-timezones.js            # dry run (default): prints, writes nothing
 *   node scripts/fix-property-timezones.js --dry-run  # same, explicit
 *   node scripts/fix-property-timezones.js --apply    # writes, one transaction
 *
 * Only a value in the explicit KNOWN_NIGERIAN table is changed (to
 * Africa/Lagos, Nigeria's single zone). A value that is a real zone with the
 * wrong letter case ("africa/lagos") is rewritten to Intl's canonical name.
 * Anything else is REPORTED and left alone, never guessed. Each change writes
 * one `audit_log` row (action `timezone_corrected`, source `migration`).
 * It touches `properties.timezone` and `audit_log` only: never
 * current_business_date, folios, payments or pos_* tables.
 */

const { normalizeTimeZone } = require('../src/shared/timezone');

const TARGET = 'Africa/Lagos';

/** Keys are lower-cased with whitespace collapsed (see `key`). */
const KNOWN_NIGERIAN = new Set([
  'lagos', 'africa', 'african/delta', 'africa/asaba', 'asaba', 'benin/ edo state', 'benin/edo state',
  'benin', 'benin city', 'edo', 'edo state', 'delta', 'delta state', 'abuja', 'africa/abuja',
  'nigeria', 'africa/nigeria', 'wat',
]);

function key(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** @returns {{ kind: 'ok'|'fix'|'unknown', to?: string }} */
function classify(value) {
  const canonical = normalizeTimeZone(value);
  if (canonical) return canonical === value ? { kind: 'ok' } : { kind: 'fix', to: canonical };
  if (value != null && (KNOWN_NIGERIAN.has(key(value)) || KNOWN_NIGERIAN.has(key(value).replace(/ ?\/ ?/g, '/')))) {
    return { kind: 'fix', to: TARGET };
  }
  return { kind: 'unknown' };
}

/**
 * @param {{ db: import('knex').Knex, argv: string[], out: (line: string) => void }} io
 * @returns {Promise<number>} exit code
 */
async function run({ db, argv, out }) {
  const unknown = argv.filter((a) => !['--dry-run', '--apply'].includes(a));
  if (unknown.length || (argv.includes('--apply') && argv.includes('--dry-run'))) {
    out(`Usage: fix-property-timezones.js [--dry-run | --apply]${unknown.length ? ` (unknown: ${unknown.join(' ')})` : ''}`);
    return 2;
  }
  const apply = argv.includes('--apply');

  const rows = await db('properties').select('id', 'tenant_id', 'name', 'timezone').orderBy('id');
  const changes = [];
  const unrecognised = [];
  for (const row of rows) {
    const result = classify(row.timezone);
    if (result.kind === 'fix') changes.push({ row, to: result.to });
    else if (result.kind === 'unknown') unrecognised.push(row);
  }

  for (const { row, to } of changes) out(`property ${row.id} (tenant ${row.tenant_id}, ${row.name}): ${JSON.stringify(row.timezone)} -> ${to}`);
  for (const row of unrecognised) out(`property ${row.id} (tenant ${row.tenant_id}, ${row.name}): ${JSON.stringify(row.timezone)} NOT RECOGNISED, left unchanged`);
  out(`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} checked: ${changes.length} to change, ${unrecognised.length} unrecognised, ${rows.length - changes.length - unrecognised.length} already valid.`);

  if (!apply) {
    out('Dry run: nothing written. Re-run with --apply to write.');
    return unrecognised.length ? 1 : 0;
  }

  await db.transaction(async (trx) => {
    for (const { row, to } of changes) {
      const n = await trx('properties').where({ id: row.id, tenant_id: row.tenant_id, timezone: row.timezone }).update({ timezone: to });
      if (n !== 1) throw new Error(`property ${row.id} changed while the script ran; rolled back`);
      await trx('audit_log').insert({
        tenant_id: row.tenant_id,
        property_id: row.id,
        entity_type: 'properties',
        entity_id: row.id,
        action: 'timezone_corrected',
        user_id: null,
        before_state: JSON.stringify({ timezone: row.timezone }),
        after_state: JSON.stringify({ timezone: to }),
        source: 'migration',
        reason: 'Invalid (non-IANA) timezone corrected by scripts/fix-property-timezones.js',
      });
    }
  });
  out(`Applied: ${changes.length} updated, ${changes.length} audit rows written.`);
  return unrecognised.length ? 1 : 0;
}

module.exports = { run, classify };

if (require.main === module) {
  const { knex, destroy } = require('../src/db');
  run({ db: knex(), argv: process.argv.slice(2), out: (line) => console.log(line) })
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`Failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => destroy());
}
