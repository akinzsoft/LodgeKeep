'use strict';

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { run, classify } = require('../../scripts/fix-property-timezones');

describe('scripts/fix-property-timezones', () => {
  const t = useTestApp();
  let ctx;
  let ids;

  const VALUES = {
    asaba: 'Africa/Asaba', edo: 'Benin/ Edo State', africa: 'Africa', lagos: 'Lagos', upper: 'LAGOS',
    lower: 'lagos', delta: 'African/delta', caseOnly: 'africa/lagos', good: 'Africa/Lagos', unknown: 'Mars/Olympus',
  };

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(async () => {
    ids = {};
    for (const [k, tz] of Object.entries(VALUES)) {
      const [id] = await t.trx('properties').insert({ tenant_id: ctx.a.id, slug: `tzfix-${k}-${Date.now()}`, name: `TZ ${k}`, timezone: tz, base_currency: 'NGN', current_business_date: '2026-10-09' });
      ids[k] = id;
    }
  });

  async function exec(argv) {
    const lines = [];
    const code = await run({ db: t.trx, argv, out: (l) => lines.push(l) });
    return { code, output: lines.join('\n') };
  }
  const tz = async (k) => (await t.trx('properties').where({ id: ids[k] }).first()).timezone;
  const audits = () => t.trx('audit_log').where({ action: 'timezone_corrected' }).whereIn('entity_id', Object.values(ids));

  it('classifies without guessing', () => {
    expect(classify('Africa/Lagos')).toEqual({ kind: 'ok' });
    expect(classify('LAGOS')).toEqual({ kind: 'fix', to: 'Africa/Lagos' });
    expect(classify('africa/lagos')).toEqual({ kind: 'fix', to: 'Africa/Lagos' });
    expect(classify('Mars/Olympus')).toEqual({ kind: 'unknown' });
    expect(classify('Europe')).toEqual({ kind: 'unknown' });
    expect(classify(null)).toEqual({ kind: 'unknown' });
  });

  it('is a dry run by default: reports every change, writes nothing', async () => {
    const { output } = await exec([]);
    expect(output).toContain('"LAGOS" -> Africa/Lagos');
    expect(output).toContain('"Mars/Olympus" NOT RECOGNISED');
    expect(output).toContain('Dry run: nothing written');
    for (const k of Object.keys(VALUES)) expect(await tz(k)).toBe(VALUES[k]);
    expect(await audits()).toHaveLength(0);
    expect((await exec(['--dry-run'])).output).toContain('Dry run');
  });

  it('--apply fixes known values, leaves unknown and valid ones, audits each change, and touches no business date', async () => {
    const { code, output } = await exec(['--apply']);
    expect(code).toBe(1); // unrecognised value remains: non-zero so it is not missed
    expect(output).toMatch(/Applied: \d+ updated/);
    for (const k of ['asaba', 'edo', 'africa', 'lagos', 'upper', 'lower', 'delta', 'caseOnly', 'good']) expect(await tz(k)).toBe('Africa/Lagos');
    expect(await tz('unknown')).toBe('Mars/Olympus');
    const rows = await audits();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.source === 'migration' && Number(r.tenant_id) === Number(ctx.a.id))).toBe(true);
    const asaba = rows.find((r) => String(r.entity_id) === String(ids.asaba));
    expect(asaba.before_state).toEqual({ timezone: 'Africa/Asaba' });
    expect(asaba.after_state).toEqual({ timezone: 'Africa/Lagos' });
    for (const id of Object.values(ids)) expect(String((await t.trx('properties').where({ id }).first()).current_business_date).slice(0, 10)).toBe('2026-10-09');
  });

  it('a second --apply changes nothing', async () => {
    await exec(['--apply']);
    const before = (await audits()).length;
    const { output } = await exec(['--apply']);
    expect(output).toMatch(/ 0 to change/);
    expect((await audits()).length).toBe(before);
  });

  it('rejects unknown or conflicting options', async () => {
    expect((await exec(['--force'])).code).toBe(2);
    expect((await exec(['--apply', '--dry-run'])).code).toBe(2);
  });
});
