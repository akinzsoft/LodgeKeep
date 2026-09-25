'use strict';

/**
 * The tenant retention-expiry purge, end to end against the two-tenant fixture:
 * the export gate, the claim (access ends AT the claim), the resumable
 * chunked deletion across every table, the two-clean-pass verification, the
 * final audit row, and that the OTHER tenant is untouched.
 *
 * One tenant (`a`) is offboarded and purged; the fixtures already seed 81 of the
 * 85 plan tables for both tenants, and this file seeds the four platform tables
 * they leave empty plus the four self-references, real files in temp storage
 * directories, and the exports. Before purging it asserts EVERY plan table holds
 * rows for BOTH tenants, so a table this test silently skipped fails loudly.
 *
 * The shared-transaction harness cannot prove per-chunk atomicity or a real race
 * (a nested transaction is inline) — `purge-race.test.js` does, on real pooled
 * connections.
 */

// The enqueue helpers write real jobs to the shared Redis; a running dev backend's
// worker could pick those up against the DEV database. Mocked: the tests assert the
// calls, never the queue.
jest.mock('../../src/jobs/tenant-data-export', () => ({
  ...jest.requireActual('../../src/jobs/tenant-data-export'),
  enqueueTenantDataExportJob: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/jobs/outbox-dispatcher', () => ({
  ...jest.requireActual('../../src/jobs/outbox-dispatcher'),
  enqueueOutboxDispatch: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { TENANT_PURGE_ORDER, RETAINED_TABLES } = require('../../src/modules/offboarding/purge-plan');
const purge = require('../../src/modules/offboarding/purge');
const { enqueueTenantDataExportJob } = require('../../src/jobs/tenant-data-export');

const DAY = 24 * 60 * 60 * 1000;

describe('tenant retention purge', () => {
  const t = useTestApp();
  let ctx;
  let dirs;
  const files = {};
  let now;
  let later; // a day after `now`: past the grace period that follows the final warning
  let beforeB;

  beforeAll(async () => {
    dirs = {
      exports: fs.mkdtempSync(path.join(os.tmpdir(), 'purge-exports-')),
      imports: fs.mkdtempSync(path.join(os.tmpdir(), 'purge-imports-')),
      menu: fs.mkdtempSync(path.join(os.tmpdir(), 'purge-menu-')),
      logos: fs.mkdtempSync(path.join(os.tmpdir(), 'purge-logos-')),
    };
    process.env.EXPORT_STORAGE_DIR = dirs.exports;
    process.env.IMPORT_STORAGE_DIR = dirs.imports;
    process.env.MENU_IMAGE_STORAGE_DIR = dirs.menu;
    process.env.PROPERTY_LOGO_STORAGE_DIR = dirs.logos;

    ctx = await seedTwoTenants(t.trx);
    now = new Date();
    later = new Date(now.getTime() + DAY);
    await arrange();
  });

  afterAll(() => {
    for (const key of ['EXPORT_STORAGE_DIR', 'IMPORT_STORAGE_DIR', 'MENU_IMAGE_STORAGE_DIR', 'PROPERTY_LOGO_STORAGE_DIR']) delete process.env[key];
    for (const dir of Object.values(dirs)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const uuidName = (ext = 'png') => `${crypto.randomUUID()}.${ext}`;
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
  const write = (dir, name, content = 'x') => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    return full;
  };

  /** Everything the fixtures do not already seed, for BOTH tenants, then the offboarding state for `a`. */
  async function arrange() {
    for (const tenant of [ctx.a, ctx.b]) {
      const property = tenant.properties[0];
      // The four PLATFORM tables the fixtures leave empty.
      const [paymentId] = await t.trx('payments').where({ tenant_id: tenant.id }).limit(1).pluck('id');
      await t.trx('payment_webhook_events').insert({
        tenant_id: tenant.id,
        property_id: property.id,
        provider: 'paystack',
        provider_event_id: `purge-fixture-${tenant.id}`,
        payload: JSON.stringify({ event: 'charge.success', data: { customer: { email: 'someone@example.com' } } }),
        verified: true,
        related_payment_id: paymentId ?? null,
      });
      await t.trx('auth_events').insert({
        tenant_id: tenant.id,
        property_id: property.id,
        user_id: tenant.users[0].id,
        audience: 'staff',
        event_type: 'login_success',
        email_attempted: `attempt-${tenant.id}@example.com`,
        ip: '203.0.113.9',
        occurred_at: now,
      });
      await t.trx('billing_payment_method_checkouts').insert({
        tenant_id: tenant.id,
        reference: `purge-checkout-${tenant.id}`,
        email: 'b@example.com',
        amount: '50.00',
        currency: 'NGN',
        status: 'pending',
        expires_at: new Date(now.getTime() + DAY),
      });
      await t.trx('impersonation_sessions').insert({
        platform_user_id: await platformUserId(),
        tenant_id: tenant.id,
        property_id: property.id,
        reason: 'purge fixture',
        expires_at: new Date(now.getTime() + DAY),
      });
    }

    // The four self-references: point one row at a sibling.
    await selfReference('rooms', 'connecting_room_id');
    await selfReference('payments', 'parent_payment_id');
    await selfReference('folio_line_items', 'related_line_item_id');
    await selfReference('stock_movements', 'reversed_movement_id');

    // Real files in the four storage kinds, for BOTH tenants.
    for (const [key, tenant] of [['a', ctx.a], ['b', ctx.b]]) {
      const menuName = uuidName();
      files[`menu_${key}`] = write(dirs.menu, menuName, png());
      await t.trx('pos_menu_items').where({ tenant_id: tenant.id }).limit(1).update({ image_path: menuName });

      const logoName = uuidName();
      files[`logo_${key}`] = write(dirs.logos, logoName, png());
      await t.trx('properties').where({ id: tenant.properties[0].id }).update({ logo_url: `/api/v1/media/property-logos/${logoName}` });

      files[`import_${key}`] = write(dirs.imports, `import-${key}-${crypto.randomUUID()}.csv`, 'a,b\n1,2\n');
      await t.trx('import_runs').where({ id: tenant.importRuns[0].id }).update({ file_path: files[`import_${key}`] });
    }

    // Tenant `a` is offboarding and past its deadline; `b` is a normal active tenant.
    await t.trx('tenants').where({ id: ctx.a.id }).update({
      status: 'offboarding',
      offboarding_requested_at: new Date(now.getTime() - 40 * DAY),
      retention_expires_at: new Date(now.getTime() - 10 * DAY),
    });
  }

  async function platformUserId() {
    const existing = await t.trx('platform_users').first('id');
    if (existing) return existing.id;
    const [id] = await t.trx('platform_users').insert({ email: 'purge-platform@example.com', password_hash: 'x', first_name: 'P', last_name: 'U', status: 'active' });
    return id;
  }

  /** Makes a second row (a clone of the first, with its unique columns changed) and points it at the first through the self-reference column. */
  async function selfReference(table, column) {
    const uniqueOverrides = {
      rooms: (row, tenant) => ({ room_number: `SR-${tenant.id}-${row.id}` }),
      payments: (row, tenant) => ({ idempotency_key: `sr-${tenant.id}-${row.id}`, provider_reference: `sr-ref-${tenant.id}-${row.id}` }),
      folio_line_items: () => ({}),
      stock_movements: () => ({}),
    };
    for (const tenant of [ctx.a, ctx.b]) {
      const [first] = await t.trx(table).where({ tenant_id: tenant.id }).orderBy('id').limit(1);
      const { id, created_at, updated_at, ...rest } = first;
      const [childId] = await t.trx(table).insert({ ...rest, ...uniqueOverrides[table](first, tenant), [column]: first.id });
      expect(childId).toBeDefined();
    }
  }

  async function countFor(table, tenantId) {
    const [row] = await t.trx(table).where({ tenant_id: tenantId }).count({ n: '*' });
    return Number(row.n);
  }

  async function snapshot(tenantId) {
    const result = {};
    for (const table of [...TENANT_PURGE_ORDER, ...RETAINED_TABLES.filter((name) => name !== 'tenants' && name !== 'platform_users')]) {
      result[table] = await countFor(table, tenantId);
    }
    return result;
  }

  async function completedExport(tenantId, { fileName = `tenant-${tenantId}-export-1.json`, content = '{"ok":true}' } = {}) {
    const full = write(dirs.exports, fileName, content);
    const [id] = await t.trx('tenant_data_exports').insert({
      tenant_id: tenantId,
      status: 'completed',
      requested_by_user_id: tenantId === ctx.a.id ? ctx.a.users[0].id : ctx.b.users[0].id,
      file_path: full,
      file_size_bytes: fs.statSync(full).size,
      completed_at: new Date(now.getTime() + 60 * 60_000), // after the 7-day warning the gate keys on
    });
    return { id, full };
  }

  it('starts from a fixture where EVERY plan table holds rows for BOTH tenants', async () => {
    const empty = [];
    for (const table of TENANT_PURGE_ORDER) {
      for (const tenant of [ctx.a, ctx.b]) if (!(await countFor(table, tenant.id))) empty.push(`${table}@${tenant.slug}`);
    }
    expect(empty).toEqual([]); // a table listed here is one this test would silently not exercise
  });

  describe('the export gate', () => {
    it('a tenant already past its deadline is warned first, and waits out the grace period — nothing is deleted or blocked', async () => {
      // Someone to warn: one active admin.
      await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).update({ role: 'admin' });
      const before = await snapshot(ctx.a.id);
      const results = await purge.runPurgeSweep({ now });
      const mine = results.filter((r) => String(r.tenantId) === String(ctx.a.id));

      expect(mine).toEqual(expect.arrayContaining([expect.objectContaining({ warned: '7d' }), expect.objectContaining({ warned: '1d' }), expect.objectContaining({ status: 'waiting', reason: 'warning_grace' })]));
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('offboarding');
      const row = await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first();
      expect(row.state).not.toBe('blocked'); // waiting on a warning is not a fault for an operator to fix
      expect(row.warned_7d_at).not.toBeNull();
      expect(row.warned_1d_at).not.toBeNull();
      expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'purge_blocked' })).toHaveLength(0);

      // Deletion is told to be a day away, even though the stored deadline is long past.
      const events = await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'offboarding.purge_warning' });
      expect(events.length).toBeGreaterThan(0);
      const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
      expect(payload.deletionDate).toBe(new Date(now.getTime() + DAY).toISOString().slice(0, 10));

      // Only the warnings, their audit rows and the queued fresh export were written.
      const after = await snapshot(ctx.a.id);
      for (const table of Object.keys(before)) {
        if (['audit_log', 'outbox_events', 'tenant_data_exports'].includes(table)) continue;
        expect(after[table]).toBe(before[table]);
      }
      expect(await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'pending' })).toHaveLength(1);
    });

    it('warns exactly once: the next tick sends nothing new', async () => {
      const outboxBefore = await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'offboarding.purge_warning' });
      await purge.runPurgeSweep({ now: new Date(now.getTime() + 5 * 60_000) });
      expect(await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'offboarding.purge_warning' })).toHaveLength(outboxBefore.length);
    });

    it('a tenant that was never warned is never purged, however overdue (gate: warning_pending)', async () => {
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      const saved = await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first();
      await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).update({ warned_1d_at: null });
      expect(await purge.evaluateGate({ tenant, now: later })).toEqual({ ok: false, reason: 'warning_pending', transient: true });
      await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).update({ warned_1d_at: saved.warned_1d_at });
    });

    it('blocks the purge when no completed export exists after the warning, without touching anything', async () => {
      const before = await snapshot(ctx.a.id);
      const results = await purge.runPurgeSweep({ now: later });

      expect(results.find((r) => String(r.tenantId) === String(ctx.a.id))).toMatchObject({ status: 'blocked', reason: 'export_missing' });
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('offboarding');
      // Nothing was deleted: the only new row is the audit row recording the block.
      expect(await snapshot(ctx.a.id)).toEqual({ ...before, audit_log: before.audit_log + 1 });
      const row = await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first();
      expect(row.state).toBe('blocked');
      expect(row.blocked_reason).toBe('export_missing');
      expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'purge_blocked' })).toHaveLength(1);
    });

    it('does not re-audit or re-queue on the next tick while the reason is unchanged', async () => {
      await purge.runPurgeSweep({ now: later });
      expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'purge_blocked' })).toHaveLength(1);
      expect(await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'pending' })).toHaveLength(1);
    });

    it('an export made BEFORE the 7-day warning does not satisfy the gate: data keeps arriving until the claim', async () => {
      const { id, full } = await completedExport(ctx.a.id, { fileName: `tenant-${ctx.a.id}-export-5.json` });
      const warned = (await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first()).warned_7d_at;
      await t.trx('tenant_data_exports').where({ id }).update({ completed_at: new Date(new Date(warned).getTime() - 60_000) });
      const gate = await purge.evaluateGate({ tenant: await t.trx('tenants').where({ id: ctx.a.id }).first(), now: later });
      expect(gate).toEqual({ ok: false, reason: 'export_missing' });
      await t.trx('tenant_data_exports').where({ id }).delete();
      fs.rmSync(full, { force: true });
    });

    it('re-enqueues an export request that is still pending an hour later (a lost queue message must not block a tenant forever)', async () => {
      enqueueTenantDataExportJob.mockClear();
      await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'pending' }).update({ created_at: new Date(now.getTime() - 2 * 60 * 60_000) });
      await purge.runPurgeSweep({ now: later });
      expect(enqueueTenantDataExportJob).toHaveBeenCalledWith(expect.objectContaining({ tenantId: String(ctx.a.id) }));
    });

    it('blocks when the export file has gone missing from disk', async () => {
      const { id, full } = await completedExport(ctx.a.id);
      fs.rmSync(full);
      const gate = await purge.evaluateGate({ tenant: await t.trx('tenants').where({ id: ctx.a.id }).first(), now: later });
      expect(gate).toEqual({ ok: false, reason: 'export_file_missing' });
      await t.trx('tenant_data_exports').where({ id }).delete();
    });

    it('blocks when the export file size no longer matches', async () => {
      const { id, full } = await completedExport(ctx.a.id);
      fs.writeFileSync(full, 'truncated-or-changed-content-that-is-a-different-size');
      const gate = await purge.evaluateGate({ tenant: await t.trx('tenants').where({ id: ctx.a.id }).first(), now: later });
      expect(gate).toEqual({ ok: false, reason: 'export_file_size_mismatch' });
      await t.trx('tenant_data_exports').where({ id }).delete();
      fs.rmSync(full, { force: true });
    });

    it('ignores an export completed BEFORE the offboarding request (an earlier cycle)', async () => {
      const { id, full } = await completedExport(ctx.a.id, { fileName: `tenant-${ctx.a.id}-export-77.json` });
      await t.trx('tenant_data_exports').where({ id }).update({ completed_at: new Date(now.getTime() - 60 * DAY) });
      const gate = await purge.evaluateGate({ tenant: await t.trx('tenants').where({ id: ctx.a.id }).first(), now: later });
      expect(gate.ok).toBe(false);
      await t.trx('tenant_data_exports').where({ id }).delete();
      fs.rmSync(full, { force: true });
    });

    it('refuses an unreasonably short retention window, so an edited date can never cause an instant purge', async () => {
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      const gate = await purge.evaluateGate({ tenant: { ...tenant, retention_expires_at: new Date(new Date(tenant.offboarding_requested_at).getTime() + DAY) }, now: later });
      expect(gate).toEqual({ ok: false, reason: 'retention_window_invalid' });
    });

    it('refuses a tenant with no retention dates', async () => {
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      expect(await purge.evaluateGate({ tenant: { ...tenant, retention_expires_at: null } })).toEqual({ ok: false, reason: 'retention_dates_missing' });
    });
  });

  describe('the purge', () => {
    let staleExport;

    beforeAll(async () => {
      // Remove the export the block queued so the completed one below is the only candidate.
      await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'pending' }).delete();
      staleExport = await completedExport(ctx.a.id);
      // An export tenant b already has must survive tenant a's purge.
      await completedExport(ctx.b.id);
      // A file named for a different tenant whose id merely STARTS with a's: never touched.
      files.lookalike = write(dirs.exports, `tenant-${ctx.a.id}0-export-1.json`, 'not tenant a');
      // In-flight work the claim must stop.
      await t.trx('tenant_data_exports').insert({ tenant_id: ctx.a.id, status: 'processing' });
      await t.trx('import_runs').insert({ tenant_id: ctx.a.id, property_id: null, entity_type: 'guests', status: 'committing', original_filename: 'x.csv', file_path: files.import_a, run_by_user_id: ctx.a.users[0].id });
      beforeB = await snapshot(ctx.b.id);
    });

    it('claims the tenant: status purging, and access ends AT the claim', async () => {
      const claim = await purge.claimTenantForPurge({ tenantId: ctx.a.id, exportId: staleExport.id, now });
      expect(claim).toEqual({ claimed: true });

      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('purging');
      expect(await t.trx('users').where({ tenant_id: ctx.a.id, status: 'active' })).toHaveLength(0);
      expect(await t.trx('guest_accounts').where({ tenant_id: ctx.a.id, status: 'active' })).toHaveLength(0);
      expect(await t.trx('sessions').where({ tenant_id: ctx.a.id }).whereNull('revoked_at')).toHaveLength(0);
      expect((await t.trx('sessions').where({ tenant_id: ctx.a.id }).first()).revoked_reason).toBe('admin_revoked');
      expect(await t.trx('tenant_domains').where({ tenant_id: ctx.a.id })).toHaveLength(0);
      expect(await t.trx('impersonation_sessions').where({ tenant_id: ctx.a.id }).whereNull('ended_at')).toHaveLength(0);
      expect(await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'processing' })).toHaveLength(0);
      expect(await t.trx('import_runs').where({ tenant_id: ctx.a.id, status: 'committing' })).toHaveLength(0);

      const subscription = await t.trx('subscriptions').where({ tenant_id: ctx.a.id }).first();
      expect(subscription.status).toBe('canceled');
      expect(subscription.payment_method_authorization_code).toBeNull();
      expect(subscription.payment_method_last4).toBeNull();
      expect(subscription.payment_method_provider).toBeNull();

      const row = await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first();
      expect(row.state).toBe('running');
      expect(String(row.export_id)).toBe(String(staleExport.id));
    });

    it('a second claim of the same tenant claims nothing (it is no longer offboarding)', async () => {
      expect(await purge.claimTenantForPurge({ tenantId: ctx.a.id, exportId: staleExport.id, now })).toEqual({ claimed: false });
    });

    it('deletes every table over two verifying ticks, then finalizes', async () => {
      const first = await purge.runPurgeTick({ tenantId: ctx.a.id, now });
      expect(first).toMatchObject({ status: 'progress', reason: 'verifying' });
      for (const table of TENANT_PURGE_ORDER) expect(await countFor(table, ctx.a.id)).toBe(0);
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('purging'); // one clean pass is not enough

      const second = await purge.runPurgeTick({ tenantId: ctx.a.id, now });
      expect(second).toEqual({ status: 'complete' });
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('purged');
    });

    it('the other tenant is completely untouched, table by table', async () => {
      expect(await snapshot(ctx.b.id)).toEqual(beforeB);
      expect((await t.trx('tenants').where({ id: ctx.b.id }).first()).status).not.toBe('purged');
      expect(await t.trx('users').where({ tenant_id: ctx.b.id, status: 'active' })).not.toHaveLength(0);
    });

    it('keeps the tombstone and the billing records, with the card token cleared', async () => {
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      expect(tenant.slug).toBe(ctx.a.slug); // the slug stays reserved
      expect(await countFor('subscriptions', ctx.a.id)).toBe(1);
      expect(await countFor('subscription_invoices', ctx.a.id)).toBeGreaterThan(0);
      expect(await countFor('subscription_payments', ctx.a.id)).toBeGreaterThan(0);
      expect((await t.trx('subscriptions').where({ tenant_id: ctx.a.id }).first()).payment_method_authorization_code).toBeNull();
    });

    it('keeps the export rows as evidence, with the file path and requester cleared and the files deleted', async () => {
      const rows = await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.file_path).toBeNull();
        expect(row.requested_by_user_id).toBeNull();
      }
      expect(fs.existsSync(staleExport.full)).toBe(false);
    });

    it('deletes the tenant’s files, and only the tenant’s files', async () => {
      for (const key of ['menu_a', 'logo_a', 'import_a']) expect(fs.existsSync(files[key])).toBe(false);
      for (const key of ['menu_b', 'logo_b', 'import_b']) expect(fs.existsSync(files[key])).toBe(true);
      expect(fs.existsSync(files.lookalike)).toBe(true); // tenant-<id>0-export-… is a different tenant's file
      expect(fs.existsSync(path.join(dirs.exports, `tenant-${ctx.b.id}-export-1.json`))).toBe(true);
    });

    it('writes exactly ONE audit row for the tenant: tenant_purged, no user, no property, counts only', async () => {
      const rows = await t.trx('audit_log').where({ tenant_id: ctx.a.id });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.action).toBe('tenant_purged');
      expect(row.user_id).toBeNull();
      expect(row.property_id).toBeNull();
      expect(row.source).toBe('job');
      const after = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state;
      expect(after.deletedRows.reservations).toBeGreaterThan(0);
      expect(after.files.deleted).toBeGreaterThan(0);
      expect(JSON.stringify(after)).not.toMatch(/@example\.com|203\.0\.113/); // counts only — no personal data
    });

    it('completes the purge row', async () => {
      const row = await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first();
      expect(row.state).toBe('completed');
      expect(row.completed_at).not.toBeNull();
      expect(row.lease_owner).toBeNull();
    });

    it('a purged tenant is never picked up again', async () => {
      const results = await purge.runPurgeSweep({ now: later });
      expect(results.find((r) => String(r.tenantId) === String(ctx.a.id))).toBeUndefined();
    });
  });
});
