'use strict';

/**
 * Data migration — PLAN.md Phase 5's last unbuilt bullet,
 * PRODUCT_REQUIREMENTS.md §3.20. HTTP-level: template download,
 * upload+dry-run for each of the four entity types, duplicate detection
 * and the "never auto-merge" resolution flow, availability-conflict
 * flagging (future vs. historical), commit (triggered via HTTP, then the
 * job's own logic run directly — mirroring `tests/billing`'s own
 * "call the sweep function directly" precedent for job-shaped work), the
 * per-row-failure-does-not-abort-the-run guarantee, RBAC, and cross-tenant
 * isolation. Rollback has its own dedicated file, `rollback.test.js`.
 */

const fs = require('fs');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { runImportCommitJob } = require('../../src/jobs/data-import');
const { sumMoney } = require('../../src/shared/money');
const { recomputeArAccountBalance } = require('../../src/modules/ar/service');
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy');

describe('Data migration (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);

    // Mirrors offboarding.test.js's own precedent exactly: user[1] holds no
    // grant at property[1] in the base fixture, so it's free to become
    // this suite's real admin-tier account.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').insert({
        tenant_id: tenant.id,
        user_id: tenant.users[1].id,
        property_id: tenant.properties[1].id,
        role: 'admin',
      });
    }

    // A business date far enough in the future that every "historical"
    // date used below is genuinely in the past relative to it, and every
    // "future" date genuinely ahead of it.
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('properties').where({ id: tenant.properties[0].id }).update({ current_business_date: '2027-06-01' });
    }
  });

  // `seedTwoTenants`'s own fixture arrays (t.guests, t.companyProfiles, ...)
  // only carry `{id}` (plus `property_id` where relevant) — real column
  // values are read back here rather than assumed/reconstructed.
  async function fixtureGuestOf(tenant) {
    return t.trx('guests').where({ id: tenant.guests[0].id }).first();
  }
  async function fixtureCompanyOf(tenant) {
    return t.trx('company_profiles').where({ id: tenant.companyProfiles[0].id }).first();
  }

  // A dedicated guest with a genuinely unique email, for the
  // reservations-import tests below — reusing the shared fixture guest
  // would risk exactly the ambiguity the guests-describe block's own
  // "create_new" test deliberately creates for ITSELF (a second guest
  // sharing the fixture's email), since every test in this file runs
  // inside the one shared, rolled-back transaction.
  async function reservationsGuest() {
    const existing = await t.trx('guests').where({ tenant_id: ctx.a.id, email: 'reservations-import-guest@example.com' }).first();
    if (existing) return existing;
    const [id] = await t.trx('guests').insert({
      tenant_id: ctx.a.id,
      first_name: 'Reservation',
      last_name: 'Importee',
      email: 'reservations-import-guest@example.com',
    });
    return t.trx('guests').where({ id }).first();
  }

  function adminToken(tenant = ctx.a) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[1].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[1].id),
    });
  }

  function managerToken(tenant = ctx.a) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  }

  function csv(headerRow, rows) {
    return [headerRow.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n';
  }

  function uploadRequest(tenant = ctx.a) {
    return t.request.post('/api/v1/migration/imports').set('Authorization', `Bearer ${adminToken(tenant)}`);
  }

  async function uploadAndDryRun({ tenant = ctx.a, entityType, propertyId, fileContent, filename }) {
    let req = uploadRequest(tenant).field('entity_type', entityType);
    if (propertyId) req = req.field('property_id', String(propertyId));
    const uploadRes = await req.attach('file', Buffer.from(fileContent, 'utf8'), filename);
    expect(uploadRes.status).toBe(201);
    const importRunId = uploadRes.body.data.id;

    const dryRunRes = await t.request
      .post(`/api/v1/migration/imports/${importRunId}/dry-run`)
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .send();
    expect(dryRunRes.status).toBe(200);

    return { importRunId, uploadRes, dryRunRes };
  }

  async function commitAndRunJob({ tenant = ctx.a, importRunId }) {
    const commitRes = await t.request
      .post(`/api/v1/migration/imports/${importRunId}/commit`)
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .send();
    expect(commitRes.status).toBe(202);
    expect(commitRes.body.data.status).toBe('committing');

    await runImportCommitJob({ tenantId: tenant.id, importRunId });

    const run = await t.trx('import_runs').where({ id: importRunId }).first();
    return { commitRes, run };
  }

  // ---------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------

  describe('templates', () => {
    it('downloads a real header-only CSV template for each supported entity type', async () => {
      const res = await t.request.get('/api/v1/migration/templates/guests').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text.trim()).toBe('first_name,last_name,email,phone,date_of_birth');
    });

    it('rejects an unknown entity type', async () => {
      const res = await t.request.get('/api/v1/migration/templates/ghosts').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_UNKNOWN_ENTITY_TYPE');
    });
  });

  // ---------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------

  describe('RBAC', () => {
    it('a manager without migration.manage is refused uploading a file', async () => {
      const res = await t.request
        .post('/api/v1/migration/imports')
        .set('Authorization', `Bearer ${managerToken()}`)
        .field('entity_type', 'guests')
        .attach('file', Buffer.from('first_name,last_name,email,phone,date_of_birth\n'), 'guests.csv');
      expect(res.status).toBe(403);
    });

    it('an admin can upload', async () => {
      const res = await uploadRequest()
        .field('entity_type', 'guests')
        .attach('file', Buffer.from('first_name,last_name,email,phone,date_of_birth\n'), 'guests.csv');
      expect(res.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------
  // Security review: a `__proto__`/`constructor`/`prototype` CSV header is
  // a prototype-pollution vector against a naive `columns: true` CSV parse
  // (GHSA-8cw4-87c7-c6xx) — rejected outright at dry-run, defense-in-depth
  // on top of the upgraded, no-longer-vulnerable `csv-parse` dependency.
  // ---------------------------------------------------------------------

  describe('unsafe CSV headers', () => {
    it.each(['__proto__', 'constructor', 'prototype', 'Constructor'])('rejects a "%s" column name at dry-run', async (columnName) => {
      const uploadRes = await uploadRequest()
        .field('entity_type', 'guests')
        .attach('file', Buffer.from(`first_name,${columnName}\nJane,x\n`), 'guests.csv');
      expect(uploadRes.status).toBe(201);

      const dryRunRes = await t.request
        .post(`/api/v1/migration/imports/${uploadRes.body.data.id}/dry-run`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send();

      expect(dryRunRes.status).toBe(400);
      expect(dryRunRes.body.error.code).toBe('VALIDATION_UNSAFE_CSV_HEADER');
    });

    it('accepts an ordinary header row with none of the reserved names', async () => {
      const { importRunId } = await uploadAndDryRun({
        entityType: 'guests',
        fileContent: 'first_name,last_name,email,phone,date_of_birth\nJane,Doe,jane@example.com,,\n',
        filename: 'guests.csv',
      });
      const run = await t.trx('import_runs').where({ id: importRunId }).first();
      expect(run.status).toBe('dry_run_complete');
    });
  });

  // ---------------------------------------------------------------------
  // Security review: a 20MB upload (multer's own cap) had no shape limit
  // at all inside it — a pathologically wide header, an unbounded number
  // of rows, or plain malformed CSV all used to reach the parser
  // unguarded, the last of which used to 500 instead of a friendly 400.
  // ---------------------------------------------------------------------

  describe('CSV shape limits', () => {
    async function dryRunFor(fileContent) {
      const uploadRes = await uploadRequest().field('entity_type', 'guests').attach('file', Buffer.from(fileContent), 'guests.csv');
      expect(uploadRes.status).toBe(201);
      return t.request.post(`/api/v1/migration/imports/${uploadRes.body.data.id}/dry-run`).set('Authorization', `Bearer ${adminToken()}`).send();
    }

    it('rejects a header row with more than the supported number of columns', async () => {
      const header = Array.from({ length: 250 }, (_, i) => `c${i}`).join(',');
      const res = await dryRunFor(`${header}\nv\n`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_TOO_MANY_IMPORT_COLUMNS');
      expect(res.body.error.details.columnCount).toBe(250);
    });

    it('rejects a file with more data rows than the supported ceiling, without fully parsing it', async () => {
      const rows = Array.from({ length: 50005 }, (_, i) => `Jane${i},Doe`).join('\n');
      const res = await dryRunFor(`first_name,last_name\n${rows}\n`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_TOO_MANY_IMPORT_ROWS');
    });

    it('rejects a genuinely malformed CSV (inconsistent column count) with a real 400, not a bare 500', async () => {
      const res = await dryRunFor('first_name,last_name,email\nJane,Doe\n');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MALFORMED_CSV');
      expect(res.body.error.details.csvErrorCode).toBe('CSV_RECORD_INCONSISTENT_COLUMNS');
    });

    it('rejects a single oversized field/record rather than buffering it unbounded', async () => {
      const res = await dryRunFor(`first_name,last_name\n${'x'.repeat(30_000)},Doe\n`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MALFORMED_CSV');
      expect(res.body.error.details.csvErrorCode).toBe('CSV_MAX_RECORD_SIZE');
    });

    it('a real file comfortably inside every limit still dry-runs normally', async () => {
      const res = await dryRunFor('first_name,last_name,email,phone,date_of_birth\nJane,Doe,jane@example.com,,\n');
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // Guests — the full dry-run -> duplicate-review -> commit loop
  // ---------------------------------------------------------------------

  describe('guests', () => {
    it('flags a likely duplicate by email, blocks commit until resolved, and correctly reuses vs. creates', async () => {
      const fixtureGuest = await fixtureGuestOf(ctx.a);
      const fileContent = csv(
        ['first_name', 'last_name', 'email', 'phone', 'date_of_birth'],
        [
          ['Jordan', 'Fixture', fixtureGuest.email, '', ''], // matches the fixture guest — a duplicate candidate
          ['Brand', 'New', 'brand-new@example.com', '', ''], // genuinely new
        ]
      );
      const { importRunId, dryRunRes } = await uploadAndDryRun({ entityType: 'guests', fileContent, filename: 'guests.csv' });

      expect(dryRunRes.body.data.run.rows_total).toBe(2);
      const duplicateFinding = dryRunRes.body.data.errors.find((e) => e.severity === 'duplicate_candidate');
      expect(duplicateFinding).toBeTruthy();
      expect(duplicateFinding.row_number).toBe(1);
      expect(duplicateFinding.message).toMatch(/email/);

      // §3.20: "never auto-merge" — commit is refused while the duplicate is unresolved.
      const blockedCommit = await t.request
        .post(`/api/v1/migration/imports/${importRunId}/commit`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send();
      expect(blockedCommit.status).toBe(422);
      expect(blockedCommit.body.error.code).toBe('VALIDATION_UNRESOLVED_DUPLICATES');
      expect(blockedCommit.body.error.details.rowNumbers).toEqual([1]);

      const resolveRes = await t.request
        .patch(`/api/v1/migration/imports/${importRunId}/duplicates/1`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ resolution: 'use_existing', matched_guest_id: fixtureGuest.id });
      expect(resolveRes.status).toBe(200);

      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(2);
      expect(run.rows_skipped).toBe(0);

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId }).orderBy('row_number');
      expect(mapRows).toHaveLength(2);
      expect(mapRows[0]).toMatchObject({ row_number: 1, entity_type: 'guest', entity_id: fixtureGuest.id, created: 0 });
      expect(mapRows[1]).toMatchObject({ row_number: 2, entity_type: 'guest' });

      const newGuest = await t.trx('guests').where({ id: mapRows[1].entity_id }).first();
      expect(newGuest.email).toBe('brand-new@example.com');

      // No second guest row was created for the resolved duplicate.
      const guestsNamedFixture = await t.trx('guests').where({ tenant_id: ctx.a.id, email: fixtureGuest.email }).select('id');
      expect(guestsNamedFixture).toHaveLength(1);
    });

    it('a "create_new" resolution creates a fresh guest instead of reusing the match', async () => {
      const fixtureGuest = await fixtureGuestOf(ctx.a);
      const fileContent = csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Jordan', 'Fixture', fixtureGuest.email, '', '']]);
      const { importRunId } = await uploadAndDryRun({ entityType: 'guests', fileContent, filename: 'guests.csv' });

      const resolveRes = await t.request
        .patch(`/api/v1/migration/imports/${importRunId}/duplicates/1`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ resolution: 'create_new' });
      expect(resolveRes.status).toBe(200);

      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(1);

      const guestsNamedFixture = await t.trx('guests').where({ tenant_id: ctx.a.id, email: fixtureGuest.email }).select('id');
      expect(guestsNamedFixture).toHaveLength(2); // the original fixture guest, plus this run's own new one
    });

    it('rejects a "use_existing" resolution naming a real guest who is NOT actually one of this row\'s own reported duplicate candidates', async () => {
      // Code-review finding: the original version only checked that
      // `matched_guest_id` named SOME real guest in the tenant, never that
      // it was one of the specific candidates THIS row's own dry run
      // actually reported.
      const fixtureGuest = await fixtureGuestOf(ctx.a);
      const [unrelatedGuestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Totally', last_name: 'Unrelated', email: 'totally-unrelated@example.com' });

      const fileContent = csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Jordan', 'Fixture', fixtureGuest.email, '', '']]);
      const { importRunId } = await uploadAndDryRun({ entityType: 'guests', fileContent, filename: 'guests-wrong-match.csv' });

      const resolveRes = await t.request
        .patch(`/api/v1/migration/imports/${importRunId}/duplicates/1`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ resolution: 'use_existing', matched_guest_id: unrelatedGuestId });
      expect(resolveRes.status).toBe(400);
      expect(resolveRes.body.error.code).toBe('VALIDATION_INVALID_DUPLICATE_RESOLUTION');

      // The real candidate itself still works.
      const correctResolveRes = await t.request
        .patch(`/api/v1/migration/imports/${importRunId}/duplicates/1`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ resolution: 'use_existing', matched_guest_id: fixtureGuest.id });
      expect(correctResolveRes.status).toBe(200);
    });

    it('a genuinely invalid row is reported and skipped, never blocking commit', async () => {
      const fileContent = csv(
        ['first_name', 'last_name', 'email', 'phone', 'date_of_birth'],
        [
          ['', '', '', '', ''], // missing everything
          ['Valid', 'Row', 'valid-row@example.com', '', ''],
        ]
      );
      const { importRunId, dryRunRes } = await uploadAndDryRun({ entityType: 'guests', fileContent, filename: 'guests.csv' });
      expect(dryRunRes.body.data.run.rows_skipped).toBe(1);
      expect(dryRunRes.body.data.run.rows_created).toBe(1);
      expect(dryRunRes.body.data.errors.some((e) => e.row_number === 1 && e.severity === 'error')).toBe(true);

      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(1);
      expect(run.rows_skipped).toBe(1);

      const created = await t.trx('guests').where({ tenant_id: ctx.a.id, email: 'valid-row@example.com' }).first();
      expect(created).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------
  // Companies
  // ---------------------------------------------------------------------

  describe('companies', () => {
    it('imports a company profile end to end', async () => {
      const fileContent = csv(
        ['name', 'type', 'billing_email', 'billing_phone', 'billing_address', 'payment_terms_days'],
        [['Globex Corp', 'company', 'billing@globex.example.com', '', '', '45']]
      );
      const { importRunId } = await uploadAndDryRun({ entityType: 'companies', fileContent, filename: 'companies.csv' });
      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(1);

      const created = await t.trx('company_profiles').where({ tenant_id: ctx.a.id, billing_email: 'billing@globex.example.com' }).first();
      expect(created).toBeTruthy();
      expect(created.payment_terms_days).toBe(45);
    });
  });

  // ---------------------------------------------------------------------
  // Reservations — historical vs. future, and the availability-conflict
  // warning that still commits once confirmed.
  // ---------------------------------------------------------------------

  describe('reservations', () => {
    it('a historical row bypasses the overbooking lock entirely; a future row is checked; a flagged conflict still commits once confirmed', async () => {
      const property = ctx.a.properties[0];
      const guest = await reservationsGuest();
      const roomType = ctx.a.roomTypes[0]; // code DLX, one physical room seeded (physicalCount=1)

      // Fill the historical date's own inventory row to capacity — proves
      // the historical row below bypasses it rather than merely not
      // needing it.
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: property.id,
        room_type_id: roomType.id,
        stay_date: '2026-06-15',
        rooms_sold: 1,
        overbooking_threshold_pct: '100.00',
      });
      // Same for the future conflict date.
      await t.trx('room_type_inventory').insert({
        tenant_id: ctx.a.id,
        property_id: property.id,
        room_type_id: roomType.id,
        stay_date: '2027-08-01',
        rooms_sold: 1,
        overbooking_threshold_pct: '100.00',
      });

      const fileContent = csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [
          [guest.email, '', 'DLX', 'BAR', '2026-06-15', '2026-06-16', '2', '0', 'checked_out', ''], // historical, already full — bypassed
          [guest.email, '', 'DLX', 'BAR', '2027-08-01', '2027-08-02', '2', '0', '', ''], // future, already full — flagged, then committed anyway
          [guest.email, '', 'DLX', 'BAR', '2027-09-01', '2027-09-02', '2', '0', '', ''], // future, clean
        ]
      );

      const { importRunId, dryRunRes } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'res.csv' });

      const conflicts = dryRunRes.body.data.errors.filter((e) => e.severity === 'availability_conflict');
      expect(conflicts.map((e) => e.row_number)).toEqual([2]);
      expect(dryRunRes.body.data.run.rows_created).toBe(3); // a conflict is a warning, not a blocking error
      expect(dryRunRes.body.data.run.rows_skipped).toBe(0);

      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(3);
      expect(run.rows_skipped).toBe(0);

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'reservation' }).orderBy('row_number');
      expect(mapRows).toHaveLength(3);

      const historicalReservation = await t.trx('reservations').where({ id: mapRows[0].entity_id }).first();
      expect(historicalReservation.status).toBe('checked_out');
      const historicalInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2026-06-15' }).first();
      expect(historicalInventory.rooms_sold).toBe(1); // unchanged — the historical row never touched it
      expect(mapRows[0].inventory_reserved).toBe(0); // historical — recorded as never having reserved anything

      const futureConflictInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-08-01' }).first();
      expect(futureConflictInventory.rooms_sold).toBe(2); // incremented despite already being "full" — the confirmed bypass
      expect(mapRows[1].inventory_reserved).toBe(1);

      const futureCleanInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-09-01' }).first();
      expect(futureCleanInventory.rooms_sold).toBe(1);
      expect(mapRows[2].inventory_reserved).toBe(1);
    });

    it('does not reserve inventory for a future-dated row imported with a non-inventory-holding status (waitlisted/cancelled/no_show/expired)', async () => {
      const property = ctx.a.properties[0];
      const guest = await reservationsGuest();
      const roomType = ctx.a.roomTypes[0];

      const fileContent = csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [
          [guest.email, '', 'DLX', 'BAR', '2027-11-01', '2027-11-02', '2', '0', 'waitlisted', ''],
          [guest.email, '', 'DLX', 'BAR', '2027-11-05', '2027-11-06', '2', '0', 'cancelled', ''],
          [guest.email, '', 'DLX', 'BAR', '2027-11-10', '2027-11-11', '2', '0', 'no_show', ''],
          [guest.email, '', 'DLX', 'BAR', '2027-11-15', '2027-11-16', '2', '0', 'expired', ''],
        ]
      );

      const { importRunId } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'res-non-holding.csv' });
      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(4);

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'reservation' }).orderBy('row_number');
      expect(mapRows).toHaveLength(4);
      for (const mapRow of mapRows) {
        expect(mapRow.inventory_reserved).toBe(0);
      }

      for (const stayDate of ['2027-11-01', '2027-11-05', '2027-11-10', '2027-11-15']) {
        const inventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: stayDate }).first();
        // No row at all is an equally correct outcome to rooms_sold: 0 —
        // `reserveInventoryForDates` (which creates the row) was never
        // called for any of these four statuses.
        expect(!inventory || inventory.rooms_sold === 0).toBe(true);
      }
    });

    describe('room numbers', () => {
      const header = ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'];
      let property;
      let guest;
      let roomType;
      const roomIds = {};

      beforeAll(async () => {
        property = ctx.a.properties[0];
        guest = await reservationsGuest();
        roomType = ctx.a.roomTypes[0]; // DLX
        for (const number of ['IMP-1', 'IMP-2', 'IMP-3', 'IMP-4', 'IMP-5']) {
          const [id] = await t.trx('rooms').insert({ tenant_id: ctx.a.id, property_id: property.id, room_type_id: roomType.id, room_number: number });
          roomIds[number] = id;
        }
        const [otherTypeId] = await t.trx('room_types').insert({ tenant_id: ctx.a.id, property_id: property.id, code: 'IMPSTD', name: 'Import Standard', default_occupancy: 2, base_rate: '90.00' });
        const [otherRoomId] = await t.trx('rooms').insert({ tenant_id: ctx.a.id, property_id: property.id, room_type_id: otherTypeId, room_number: 'IMP-STD' });
        roomIds['IMP-STD'] = otherRoomId;
      });

      async function openAssignments(roomId) {
        const row = await t.trx('reservation_rooms').where({ room_id: roomId, effective_to: null }).count({ n: '*' }).first();
        return Number(row.n);
      }

      it('dry run blocks an in-house guest into an occupied room or a room an earlier row already claimed; a free room imports as occupied', async () => {
        await t.trx('rooms').where({ id: roomIds['IMP-1'] }).update({ front_desk_status: 'occupied' });

        const fileContent = csv(header, [
          [guest.email, '', 'DLX', 'BAR', '2027-12-01', '2027-12-05', '2', '0', 'checked_in', 'IMP-1'], // occupied by a live guest
          [guest.email, '', 'DLX', 'BAR', '2027-12-01', '2027-12-05', '2', '0', 'checked_in', 'IMP-2'], // free
          [guest.email, '', 'DLX', 'BAR', '2027-12-01', '2027-12-05', '2', '0', 'checked_in', 'imp-2'], // same room as row 2
        ]);
        const { importRunId, dryRunRes } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'inhouse.csv' });

        const roomErrors = dryRunRes.body.data.errors.filter((e) => e.column_name === 'room_number');
        expect(roomErrors.map((e) => e.row_number)).toEqual([1, 3]);
        expect(roomErrors[0].message).toMatch(/already occupied/);
        expect(roomErrors[1].message).toMatch(/row 2/);

        const { run } = await commitAndRunJob({ importRunId });
        expect(run.rows_created).toBe(1);
        expect(run.rows_skipped).toBe(2);
        expect(await openAssignments(roomIds['IMP-1'])).toBe(0);
        expect(await openAssignments(roomIds['IMP-2'])).toBe(1);
        const room2 = await t.trx('rooms').where({ id: roomIds['IMP-2'] }).first();
        expect(room2.front_desk_status).toBe('occupied');
      });

      it('an in-house room that becomes occupied between dry run and commit skips that row only, without touching inventory', async () => {
        const fileContent = csv(header, [
          [guest.email, '', 'DLX', 'BAR', '2027-12-10', '2027-12-12', '2', '0', 'checked_in', 'IMP-3'],
          [guest.email, '', 'DLX', 'BAR', '2027-12-10', '2027-12-12', '2', '0', 'checked_in', 'IMP-4'],
        ]);
        const { importRunId, dryRunRes } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'inhouse-race.csv' });
        expect(dryRunRes.body.data.errors.filter((e) => e.severity === 'error')).toEqual([]);

        // A live check-in lands in IMP-3 after the dry run.
        await t.trx('rooms').where({ id: roomIds['IMP-3'] }).update({ front_desk_status: 'occupied' });
        const soldBefore = await t.trx('room_type_inventory').where({ room_type_id: roomType.id, stay_date: '2027-12-10' }).first();

        const { run } = await commitAndRunJob({ importRunId });
        expect(run.status).toBe('completed');
        expect(run.rows_created).toBe(1);
        expect(run.rows_skipped).toBe(1);

        const commitErrors = await t.trx('import_row_errors').where({ import_run_id: importRunId, row_number: 1 });
        expect(commitErrors.map((e) => e.message).join(' ')).toMatch(/Room IMP-3 is already occupied/);
        expect(await openAssignments(roomIds['IMP-3'])).toBe(0);
        expect(await openAssignments(roomIds['IMP-4'])).toBe(1);

        const soldAfter = await t.trx('room_type_inventory').where({ room_type_id: roomType.id, stay_date: '2027-12-10' }).first();
        expect(soldAfter.rooms_sold).toBe((soldBefore?.rooms_sold ?? 0) + 1); // only the imported row, not the skipped one
      });

      it('a booking not yet checked in keeps its room number as a preferred room, never an assignment; cancelled or wrong-type rooms are dropped', async () => {
        const fileContent = csv(header, [
          [guest.email, '', 'DLX', 'BAR', '2028-01-01', '2028-01-02', '2', '0', 'confirmed', 'IMP-5'],
          [guest.email, '', 'DLX', 'BAR', '2028-01-03', '2028-01-04', '2', '0', 'waitlisted', 'IMP-5'],
          [guest.email, '', 'DLX', 'BAR', '2028-01-05', '2028-01-06', '2', '0', 'cancelled', 'IMP-5'],
          [guest.email, '', 'DLX', 'BAR', '2028-01-07', '2028-01-08', '2', '0', 'confirmed', 'IMP-STD'],
        ]);
        const { importRunId } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'preferred.csv' });
        const { run } = await commitAndRunJob({ importRunId });
        expect(run.rows_created).toBe(4);

        const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId }).orderBy('row_number');
        const reservations = await Promise.all(mapRows.map((m) => t.trx('reservations').where({ id: m.entity_id }).first()));
        expect(reservations.map((r) => (r.preferred_room_id == null ? null : String(r.preferred_room_id)))).toEqual([
          String(roomIds['IMP-5']),
          String(roomIds['IMP-5']),
          null,
          null,
        ]);
        expect(await openAssignments(roomIds['IMP-5'])).toBe(0);
        const room5 = await t.trx('rooms').where({ id: roomIds['IMP-5'] }).first();
        expect(room5.front_desk_status).not.toBe('occupied');
      });
    });

    it('requires property_id for a reservations import', async () => {
      const res = await uploadRequest()
        .field('entity_type', 'reservations')
        .attach('file', Buffer.from('guest_email\n'), 'res.csv');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_PROPERTY_ID');
    });
  });

  // ---------------------------------------------------------------------
  // AR balances — opening balance, reusing an existing account
  // ---------------------------------------------------------------------

  describe('ar_balances', () => {
    it('imports an opening balance against an existing AR account without disturbing real charges/payments already on it', async () => {
      const property = ctx.a.properties[0];
      const account = ctx.a.arAccounts[0];
      const company = await fixtureCompanyOf(ctx.a);

      // The fixture's own `ar_accounts[0]` already carries REAL charges
      // billed to it (fixtures.js's own "AR, continued" block) — this test
      // exists specifically to prove the opening balance ADDS to that real
      // activity via `recomputeArAccountBalance`, never overwrites it. But
      // `fixtures.js` inserts its rows directly, bypassing the normal
      // recompute path entirely — the account's own stored `current_balance`
      // is therefore stale (still its inserted default) and not itself a
      // trustworthy baseline. Recomputing for real establishes the TRUE
      // pre-import balance to assert against, rather than a hardcoded
      // literal or a stale stored value that would only coincidentally be
      // correct.
      const trueBaseline = await scopedDb()
        .for(workerContext({ tenantId: ctx.a.id, propertyId: property.id }))
        .transaction((trx) => recomputeArAccountBalance({ trx, arAccountId: account.id }));
      const expectedBalance = sumMoney([trueBaseline.current_balance, '500.00']);

      const fileContent = csv(
        ['company_email', 'amount', 'currency', 'credit_limit', 'enforcement_mode'],
        [[company.billing_email, '500.00', 'NGN', '', '']]
      );
      const { importRunId } = await uploadAndDryRun({ entityType: 'ar_balances', propertyId: property.id, fileContent, filename: 'ar.csv' });
      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');
      expect(run.rows_created).toBe(1);

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId }).orderBy('id');
      const accountMap = mapRows.find((row) => row.entity_type === 'ar_account');
      const invoiceMap = mapRows.find((row) => row.entity_type === 'ar_invoice');
      expect(String(accountMap.entity_id)).toBe(String(account.id)); // reused the pre-existing account, not a new one
      expect(accountMap.created).toBe(0);
      expect(invoiceMap.created).toBe(1);

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.opening_balance_imported).toBe(sumMoney([trueBaseline.opening_balance_imported, '500.00']));
      expect(updatedAccount.current_balance).toBe(expectedBalance); // the real pre-existing charges/payments PLUS the imported balance — never just the imported amount alone

      const invoiceLine = await t.trx('ar_invoice_lines').where({ ar_invoice_id: invoiceMap.entity_id }).first();
      expect(invoiceLine.source).toBe('migration_opening_balance');
      expect(invoiceLine.folio_line_item_id).toBeNull();
      expect(invoiceLine.amount).toBe('500.00');
    });

    it('creates a brand-new AR account when the company has none yet', async () => {
      const property = ctx.a.properties[0];
      const newCompanyId = await t.trx('company_profiles').insert({ tenant_id: ctx.a.id, name: 'No Account Yet', type: 'company', billing_email: 'noaccount@example.com', payment_terms_days: 30 });
      const fileContent = csv(['company_email', 'amount', 'currency', 'credit_limit', 'enforcement_mode'], [['noaccount@example.com', '200.00', 'NGN', '1000.00', 'flag_only']]);
      const { importRunId } = await uploadAndDryRun({ entityType: 'ar_balances', propertyId: property.id, fileContent, filename: 'ar2.csv' });
      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed');

      const account = await t.trx('ar_accounts').where({ company_profile_id: newCompanyId[0] ?? newCompanyId }).first();
      expect(account).toBeTruthy();
      expect(account.enforcement_mode).toBe('flag_only');
      expect(account.opening_balance_imported).toBe('200.00');

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'ar_account' }).first();
      expect(mapRows.created).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Per-row failure does not abort the whole run
  // ---------------------------------------------------------------------

  describe('per-row commit failure', () => {
    it('a row that fails at actual commit time (a real race after dry run) is skipped and recorded; the rest of the run still completes', async () => {
      const property = ctx.a.properties[0];
      const guest = await reservationsGuest();

      const fileContent = csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [
          [guest.email, '', 'DLX', 'BAR', '2027-10-01', '2027-10-02', '2', '0', '', ''],
          [guest.email, '', 'DLX', 'BAR', '2027-10-05', '2027-10-06', '2', '0', '', ''],
        ]
      );
      const { importRunId } = await uploadAndDryRun({ entityType: 'reservations', propertyId: property.id, fileContent, filename: 'race.csv' });

      // A real race dry run cannot see: the rate code is archived after the
      // preview but before commit actually runs.
      await t.trx('rate_codes').where({ id: ctx.a.rateCodes[0].id }).update({ status: 'archived' });

      const { run } = await commitAndRunJob({ importRunId });
      expect(run.status).toBe('completed'); // never "failed" — one bad row does not abort the run
      expect(run.rows_created).toBe(0);
      expect(run.rows_skipped).toBe(2);

      const errors = await t.trx('import_row_errors').where({ import_run_id: importRunId, severity: 'error' }).orderBy('row_number');
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------
  // Code-review finding: a catastrophic failure (not a per-row one) used
  // to flip the run straight to `failed` on its very first attempt,
  // silently defeating BullMQ's own configured 3-attempt retry — a
  // retried attempt saw the terminal `failed` status and no-op'd
  // immediately. `status` now only becomes terminal on the LAST
  // configured attempt.
  // ---------------------------------------------------------------------

  describe('commit job retry behaviour', () => {
    it('a non-final attempt leaves the run "committing" on catastrophic failure, so a real BullMQ retry can genuinely re-enter it', async () => {
      const { importRunId } = await uploadAndDryRun({
        entityType: 'guests',
        fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Retry', 'Attempt', 'retry-attempt-1@example.com', '', '']]),
        filename: 'retry1.csv',
      });
      const commitRes = await t.request.post(`/api/v1/migration/imports/${importRunId}/commit`).set('Authorization', `Bearer ${adminToken()}`).send();
      expect(commitRes.status).toBe(202);

      const run = await t.trx('import_runs').where({ id: importRunId }).first();
      fs.unlinkSync(run.file_path); // the catastrophic, whole-job failure this outer catch exists for

      await expect(runImportCommitJob({ tenantId: ctx.a.id, importRunId, attemptsMade: 0, maxAttempts: 3 })).rejects.toThrow();

      const afterFirstAttempt = await t.trx('import_runs').where({ id: importRunId }).first();
      expect(afterFirstAttempt.status).toBe('committing'); // NOT "failed" — a retry must still be able to re-enter
      expect(afterFirstAttempt.failed_reason).toBeNull();
    });

    it('the final configured attempt marks the run "failed" for real, with the actual error recorded', async () => {
      const { importRunId } = await uploadAndDryRun({
        entityType: 'guests',
        fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Retry', 'Final', 'retry-attempt-final@example.com', '', '']]),
        filename: 'retry2.csv',
      });
      const commitRes = await t.request.post(`/api/v1/migration/imports/${importRunId}/commit`).set('Authorization', `Bearer ${adminToken()}`).send();
      expect(commitRes.status).toBe(202);

      const run = await t.trx('import_runs').where({ id: importRunId }).first();
      fs.unlinkSync(run.file_path);

      await expect(runImportCommitJob({ tenantId: ctx.a.id, importRunId, attemptsMade: 2, maxAttempts: 3 })).rejects.toThrow();

      const afterFinalAttempt = await t.trx('import_runs').where({ id: importRunId }).first();
      expect(afterFinalAttempt.status).toBe('failed');
      expect(afterFinalAttempt.failed_reason).toBeTruthy();
    });

    it('a direct call with no attempt info behaves exactly like a single-attempt job\'s only try (unchanged pre-fix behaviour, and what every OTHER test in this file relies on)', async () => {
      const { importRunId } = await uploadAndDryRun({
        entityType: 'guests',
        fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Retry', 'Default', 'retry-attempt-default@example.com', '', '']]),
        filename: 'retry3.csv',
      });
      const commitRes = await t.request.post(`/api/v1/migration/imports/${importRunId}/commit`).set('Authorization', `Bearer ${adminToken()}`).send();
      expect(commitRes.status).toBe(202);

      const run = await t.trx('import_runs').where({ id: importRunId }).first();
      fs.unlinkSync(run.file_path);

      await expect(runImportCommitJob({ tenantId: ctx.a.id, importRunId })).rejects.toThrow();

      const after = await t.trx('import_runs').where({ id: importRunId }).first();
      expect(after.status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------------
  // History + cross-tenant isolation
  // ---------------------------------------------------------------------

  describe('history and isolation', () => {
    it('lists a tenant\'s own runs, most recent first', async () => {
      const res = await t.request.get('/api/v1/migration/imports').set('Authorization', `Bearer ${adminToken()}`).send();
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('a run belonging to another tenant is a plain 404, never a 403', async () => {
      const bFileContent = csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['B', 'Tenant', 'b-tenant@example.com', '', '']]);
      const uploadRes = await uploadRequest(ctx.b).field('entity_type', 'guests').attach('file', Buffer.from(bFileContent, 'utf8'), 'guests.csv');
      expect(uploadRes.status).toBe(201);
      const bImportRunId = uploadRes.body.data.id;

      const res = await t.request.get(`/api/v1/migration/imports/${bImportRunId}`).set('Authorization', `Bearer ${adminToken(ctx.a)}`).send();
      expect(res.status).toBe(404);
    });
  });
});
