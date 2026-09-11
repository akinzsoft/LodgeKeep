'use strict';

/**
 * The actual export-bundle generation — `src/jobs/tenant-data-export.js`'s
 * `generateTenantDataExport`. Exercised directly against the real seeded
 * fixture data (not through BullMQ/Redis — that transport is untested by
 * design, the same tested-logic/untested-transport boundary every other
 * job in this codebase already draws), proving the produced file's actual
 * contents: real data present, denylisted tables/columns genuinely absent,
 * and multi-property aggregation working.
 */

const fs = require('fs');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { generateTenantDataExport, exportableTables } = require('../../src/jobs/tenant-data-export');

describe('Tenant data export bundle — PLAN.md Phase 5', () => {
  const t = useTestApp();
  let ctx;
  const writtenFiles = [];

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  afterAll(() => {
    for (const filePath of writtenFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone — fine
      }
    }
  });

  it('never includes a table on the denylist, regardless of scope', () => {
    const tables = exportableTables();
    for (const denied of ['sessions', 'password_resets', 'mfa_devices', 'mfa_login_codes', 'audit_log', 'roles', 'role_permissions', 'tenant_domains', 'idempotency_keys', 'tenants', 'properties']) {
      expect(tables).not.toContain(denied);
    }
    // Sanity: real guest/reservation/folio tables ARE included — the whole point of the export.
    for (const included of ['guests', 'reservations', 'folios', 'folio_line_items', 'room_types', 'rooms']) {
      expect(tables).toContain(included);
    }
  });

  it('produces a real file with the tenant identity, every property, and genuine seeded business data — nothing from the other tenant', async () => {
    const { filePath, fileSizeBytes } = await generateTenantDataExport({ tenantId: ctx.a.id, exportId: 'jest-export-job-test-1' });
    writtenFiles.push(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fileSizeBytes).toBeGreaterThan(0);

    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(String(bundle.tenant.id)).toBe(String(ctx.a.id));
    expect(bundle.tenant.slug).toBe(ctx.a.slug);
    // Only business-identity fields — never internal lifecycle/billing state.
    expect(bundle.tenant.status).toBeUndefined();
    expect(bundle.tenant.plan_id).toBeUndefined();

    // Multi-property aggregation: this tenant's fixture has two properties.
    expect(bundle.properties).toHaveLength(2);
    const propertyIds = bundle.properties.map((p) => String(p.id));
    for (const property of ctx.a.properties) {
      expect(propertyIds).toContain(String(property.id));
    }

    // Real seeded business data, genuinely present.
    expect(bundle.guests.length).toBeGreaterThan(0);
    expect(bundle.reservations.length).toBeGreaterThan(0);
    expect(bundle.room_types.some((rt) => String(rt.id) === String(ctx.a.roomTypes[0].id))).toBe(true);

    // Nothing from tenant B leaked in.
    const otherTenantRoomTypeIds = ctx.b.roomTypes.map((rt) => String(rt.id));
    for (const row of bundle.room_types) {
      expect(otherTenantRoomTypeIds).not.toContain(String(row.id));
    }

    // Denylisted tables genuinely absent from the produced document, not just empty.
    for (const denied of ['sessions', 'audit_log', 'roles', 'mfa_devices', 'tenant_domains']) {
      expect(Object.prototype.hasOwnProperty.call(bundle, denied)).toBe(false);
    }
  });

  it('never leaks a password hash or an MFA secret, even for an included table', async () => {
    const { filePath } = await generateTenantDataExport({ tenantId: ctx.a.id, exportId: 'jest-export-job-test-2' });
    writtenFiles.push(filePath);
    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(bundle.users.length).toBeGreaterThan(0);
    for (const user of bundle.users) {
      expect(user.password_hash).toBeUndefined();
      expect(user.mfa_secret).toBeUndefined();
    }

    if (bundle.guest_accounts) {
      for (const account of bundle.guest_accounts) {
        expect(account.password_hash).toBeUndefined();
      }
    }
  });
});
