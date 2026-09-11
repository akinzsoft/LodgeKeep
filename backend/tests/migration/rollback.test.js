'use strict';

/**
 * Data migration rollback — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.20:
 * "a run can be rolled back wholesale." This session's confirmed decision:
 * delete everything still untouched, refuse and report the rest — an
 * honest partial rollback, never a silent skip or a forced cascade delete.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { runImportCommitJob } = require('../../src/jobs/data-import');

describe('Data migration — rollback (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    for (const tenant of [ctx.a, ctx.b]) {
      await t.trx('user_property_access').insert({
        tenant_id: tenant.id,
        user_id: tenant.users[1].id,
        property_id: tenant.properties[1].id,
        role: 'admin',
      });
      await t.trx('properties').where({ id: tenant.properties[0].id }).update({ current_business_date: '2027-06-01' });
    }
  });

  function adminToken(tenant = ctx.a) {
    return signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[1].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[1].id),
    });
  }

  function csv(headerRow, rows) {
    return [headerRow.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n';
  }

  async function importAndCommit({ tenant = ctx.a, entityType, propertyId, fileContent }) {
    let req = t.request
      .post('/api/v1/migration/imports')
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .field('entity_type', entityType);
    if (propertyId) req = req.field('property_id', String(propertyId));
    const uploadRes = await req.attach('file', Buffer.from(fileContent, 'utf8'), `${entityType}.csv`);
    expect(uploadRes.status).toBe(201);
    const importRunId = uploadRes.body.data.id;

    const dryRunRes = await t.request
      .post(`/api/v1/migration/imports/${importRunId}/dry-run`)
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .send();
    expect(dryRunRes.status).toBe(200);

    const commitRes = await t.request
      .post(`/api/v1/migration/imports/${importRunId}/commit`)
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .send();
    expect(commitRes.status).toBe(202);

    await runImportCommitJob({ tenantId: tenant.id, importRunId });
    return importRunId;
  }

  async function rollback(importRunId, tenant = ctx.a) {
    return t.request
      .post(`/api/v1/migration/imports/${importRunId}/rollback`)
      .set('Authorization', `Bearer ${adminToken(tenant)}`)
      .send({ reason: 'Test data was wrong' });
  }

  it('rolls back an untouched guest import completely — the guest row is deleted and the run is marked rolled_back', async () => {
    const importRunId = await importAndCommit({
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Roll', 'Back', 'rollback-me@example.com', '', '']]),
    });

    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'guest' }).first();
    const guestId = mapRow.entity_id;
    expect(await t.trx('guests').where({ id: guestId }).first()).toBeTruthy();

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rolled_back');
    expect(res.body.data.rowsRolledBack).toBe(1);
    expect(res.body.data.rowsRefused).toEqual([]);

    expect(await t.trx('guests').where({ id: guestId }).first()).toBeUndefined();
    expect(await t.trx('imported_record_map').where({ import_run_id: importRunId }).first()).toBeUndefined();

    const run = await t.trx('import_runs').where({ id: importRunId }).first();
    expect(run.status).toBe('rolled_back');
  });

  it('rejects rollback of a run that is not yet completed', async () => {
    const uploadRes = await t.request
      .post('/api/v1/migration/imports')
      .set('Authorization', `Bearer ${adminToken()}`)
      .field('entity_type', 'guests')
      .attach('file', Buffer.from('first_name,last_name,email,phone,date_of_birth\n'), 'guests.csv');
    const importRunId = uploadRes.body.data.id;

    const res = await rollback(importRunId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_INVALID_IMPORT_RUN_STATE');
  });

  it('refuses to remove a guest that a reservation now references, reporting it and leaving the row in place — a partial rollback', async () => {
    const importRunId = await importAndCommit({
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Still', 'Referenced', 'still-referenced@example.com', '', '']]),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'guest' }).first();
    const guestId = mapRow.entity_id;

    // A real reservation now references this migrated guest — created
    // through ordinary means, not through this import run.
    const property = ctx.a.properties[0];
    const roomType = ctx.a.roomTypes[0];
    const rateCode = ctx.a.rateCodes[0];
    await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      guest_id: guestId,
      room_type_id: roomType.id,
      rate_code_id: rateCode.id,
      arrival_date: '2027-12-01',
      departure_date: '2027-12-02',
      status: 'confirmed',
      confirmation_number: 'ROLLBACK-TEST-GUEST-REF',
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRolledBack).toBe(0);
    expect(res.body.data.rowsRefused).toHaveLength(1);
    expect(res.body.data.rowsRefused[0].entityType).toBe('guest');

    // Still there — refused, not deleted.
    expect(await t.trx('guests').where({ id: guestId }).first()).toBeTruthy();
    const run = await t.trx('import_runs').where({ id: importRunId }).first();
    expect(run.status).toBe('partially_rolled_back');
  });

  it('refuses to remove a reservation that has since been checked in', async () => {
    const property = ctx.a.properties[0];
    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Checked', last_name: 'In', email: 'checked-in-rollback@example.com' });

    const importRunId = await importAndCommit({
      entityType: 'reservations',
      propertyId: property.id,
      fileContent: csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [['checked-in-rollback@example.com', '', 'DLX', 'BAR', '2027-11-01', '2027-11-02', '2', '0', '', '']]
      ),
    });

    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'reservation' }).first();
    await t.trx('reservations').where({ id: mapRow.entity_id }).update({ status: 'checked_in' });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('reservation');
    expect(await t.trx('reservations').where({ id: mapRow.entity_id }).first()).toBeTruthy();
  });

  it('rolls back an untouched future reservation and releases the inventory it held', async () => {
    const property = ctx.a.properties[0];
    const roomType = ctx.a.roomTypes[0];
    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Release', last_name: 'Inventory', email: 'release-inventory@example.com' });

    const importRunId = await importAndCommit({
      entityType: 'reservations',
      propertyId: property.id,
      fileContent: csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [['release-inventory@example.com', '', 'DLX', 'BAR', '2027-12-10', '2027-12-11', '2', '0', '', '']]
      ),
    });

    const beforeInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-12-10' }).first();
    expect(beforeInventory.rooms_sold).toBe(1);

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rolled_back');

    const afterInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-12-10' }).first();
    expect(afterInventory.rooms_sold).toBe(0);
  });

  it('rolls back an ar_balances import — the synthetic invoice/lines are removed and the account balance reverts, without touching a real payment', async () => {
    const property = ctx.a.properties[0];
    const [companyId] = await t.trx('company_profiles').insert({ tenant_id: ctx.a.id, name: 'Rollback Co', type: 'company', billing_email: 'rollback-co@example.com', payment_terms_days: 30 });

    const importRunId = await importAndCommit({
      entityType: 'ar_balances',
      propertyId: property.id,
      fileContent: csv(['company_email', 'amount', 'currency', 'credit_limit', 'enforcement_mode'], [['rollback-co@example.com', '300.00', 'NGN', '', '']]),
    });

    const accountMap = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'ar_account' }).first();
    const invoiceMap = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'ar_invoice' }).first();
    expect(accountMap.created).toBe(1); // a brand-new account for this brand-new company

    const beforeAccount = await t.trx('ar_accounts').where({ id: accountMap.entity_id }).first();
    expect(beforeAccount.opening_balance_imported).toBe('300.00');

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rolled_back');

    expect(await t.trx('ar_invoices').where({ id: invoiceMap.entity_id }).first()).toBeUndefined();
    expect(await t.trx('ar_accounts').where({ id: accountMap.entity_id }).first()).toBeUndefined();
  });

  it('refuses to remove an AR account a real payment has since been recorded against', async () => {
    const property = ctx.a.properties[0];
    const [companyId] = await t.trx('company_profiles').insert({ tenant_id: ctx.a.id, name: 'Paid Co', type: 'company', billing_email: 'paid-co@example.com', payment_terms_days: 30 });

    const importRunId = await importAndCommit({
      entityType: 'ar_balances',
      propertyId: property.id,
      fileContent: csv(['company_email', 'amount', 'currency', 'credit_limit', 'enforcement_mode'], [['paid-co@example.com', '400.00', 'NGN', '', '']]),
    });

    const accountMap = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'ar_account' }).first();
    await t.trx('ar_payments').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      ar_account_id: accountMap.entity_id,
      amount: '50.00',
      currency: 'NGN',
      method_label: 'wire',
      received_at: '2027-06-01',
      business_date: '2027-06-01',
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused.some((row) => row.entityType === 'ar_account')).toBe(true);
    expect(await t.trx('ar_accounts').where({ id: accountMap.entity_id }).first()).toBeTruthy();
  });

  // -----------------------------------------------------------------
  // Regression coverage for a code-review pass before this shipped —
  // see migration/service.js's own inline comments for each fix.
  // -----------------------------------------------------------------

  it('releases inventory correctly even after the property business date has advanced past the reservation, closing the one-directional leak the original business-date-relative check had', async () => {
    const property = ctx.a.properties[0];
    const roomType = ctx.a.roomTypes[0];
    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Advance', last_name: 'Leak', email: 'advance-leak@example.com' });

    const importRunId = await importAndCommit({
      entityType: 'reservations',
      propertyId: property.id,
      fileContent: csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [['advance-leak@example.com', '', 'DLX', 'BAR', '2027-06-20', '2027-06-21', '2', '0', '', '']]
      ),
    });

    const beforeInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-06-20' }).first();
    expect(beforeInventory.rooms_sold).toBe(1); // genuinely reserved at commit time

    // The property's business date advances PAST this reservation's own
    // departure date before anyone gets around to rolling the run back —
    // the exact scenario Night Audit's daily rollover produces in real
    // operation. The old, business-date-relative check would have wrongly
    // concluded "this looks historical, it never held inventory" here and
    // silently skipped the release.
    await t.trx('properties').where({ id: property.id }).update({ current_business_date: '2027-12-31' });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rolled_back');

    const afterInventory = await t.trx('room_type_inventory').where({ property_id: property.id, room_type_id: roomType.id, stay_date: '2027-06-20' }).first();
    expect(afterInventory.rooms_sold).toBe(0); // correctly released — no leaked +1

    await t.trx('properties').where({ id: property.id }).update({ current_business_date: '2027-06-01' });
  });

  it('refuses to remove a reservation with a SECOND folio carrying real charges (split billing) — the original check only inspected the first folio', async () => {
    const property = ctx.a.properties[0];
    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Split', last_name: 'Billing', email: 'split-billing-rollback@example.com' });

    const importRunId = await importAndCommit({
      entityType: 'reservations',
      propertyId: property.id,
      fileContent: csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [['split-billing-rollback@example.com', '', 'DLX', 'BAR', '2027-07-01', '2027-07-02', '2', '0', '', '']]
      ),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'reservation' }).first();
    const reservationId = mapRow.entity_id;

    // A first, empty folio (opened normally, no charges — would not block
    // rollback on its own) plus a SECOND folio that carries a real charge.
    const [firstFolioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      reservation_id: reservationId,
      folio_number: 'ROLLBACK-SPLIT-1',
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Guest',
    });
    const [secondFolioId] = await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      reservation_id: reservationId,
      folio_number: 'ROLLBACK-SPLIT-2',
      status: 'open',
      balance: '75.00',
      currency: 'NGN',
      billed_to: 'Guest',
    });
    await t.trx('folio_line_items').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      folio_id: secondFolioId,
      type: 'room_charge',
      description: 'Split-billed charge',
      amount: '75.00',
      currency: 'NGN',
      business_date: '2027-06-01',
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('reservation');
    expect(await t.trx('reservations').where({ id: reservationId }).first()).toBeTruthy();
    expect(await t.trx('folios').where({ id: firstFolioId }).first()).toBeTruthy();
    expect(await t.trx('folios').where({ id: secondFolioId }).first()).toBeTruthy();
  });

  it('refuses to remove a guest that has since registered a guest-portal account', async () => {
    const importRunId = await importAndCommit({
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Portal', 'Guest', 'portal-guest-rollback@example.com', '', '']]),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'guest' }).first();
    const guestId = mapRow.entity_id;

    await t.trx('guest_accounts').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      guest_id: guestId,
      email: 'portal-guest-rollback@example.com',
      password_hash: 'x',
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('guest');
    expect(await t.trx('guests').where({ id: guestId }).first()).toBeTruthy();
  });

  it("refuses to remove a guest a LATER import's duplicate-guest resolution now references", async () => {
    const importRunId = await importAndCommit({
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Later', 'Matched', 'later-matched-rollback@example.com', '', '']]),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'guest' }).first();
    const guestId = mapRow.entity_id;

    // A later import's own dry run resolved a duplicate candidate against
    // this exact guest — the real RESTRICT FK `import_row_errors.resolved_guest_id`.
    const laterImportRunId = await importAndCommit({
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['Roll', 'Backer', 'unrelated-second-run@example.com', '', '']]),
    });
    await t.trx('import_row_errors').insert({
      tenant_id: ctx.a.id,
      import_run_id: laterImportRunId,
      row_number: 1,
      severity: 'duplicate_candidate',
      message: 'Matches an existing guest on email.',
      resolution: 'use_existing',
      resolved_guest_id: guestId,
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('guest');
    expect(await t.trx('guests').where({ id: guestId }).first()).toBeTruthy();
  });

  it('refuses to remove a company a real folio is now billed directly to', async () => {
    const property = ctx.a.properties[0];
    const [companyId] = await t.trx('company_profiles').insert({ tenant_id: ctx.a.id, name: 'Folio Billed Co', type: 'company', billing_email: 'folio-billed@example.com', payment_terms_days: 30 });
    const importRunId = await importAndCommit({
      entityType: 'companies',
      fileContent: csv(['name', 'type', 'billing_email', 'billing_phone', 'billing_address', 'payment_terms_days'], [['Folio Billed Co Two', 'company', 'folio-billed-co-two@example.com', '', '', '']]),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'company_profile' }).first();
    const migratedCompanyId = mapRow.entity_id;

    const [guestId] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Bill', last_name: 'ToCompany', email: 'bill-to-company-rollback@example.com' });
    const [reservationId] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      guest_id: guestId,
      room_type_id: ctx.a.roomTypes[0].id,
      rate_code_id: ctx.a.rateCodes[0].id,
      arrival_date: '2027-08-01',
      departure_date: '2027-08-02',
      status: 'confirmed',
      confirmation_number: 'ROLLBACK-FOLIO-COMPANY',
    });
    await t.trx('folios').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      reservation_id: reservationId,
      folio_number: 'ROLLBACK-FOLIO-BILLED',
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: 'Folio Billed Co Two',
      company_profile_id: migratedCompanyId,
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('company_profile');
    expect(await t.trx('company_profiles').where({ id: migratedCompanyId }).first()).toBeTruthy();
  });

  it('refuses to remove a company a real group block now sponsors', async () => {
    const property = ctx.a.properties[0];
    const importRunId = await importAndCommit({
      entityType: 'companies',
      fileContent: csv(['name', 'type', 'billing_email', 'billing_phone', 'billing_address', 'payment_terms_days'], [['Sponsor Co', 'company', 'sponsor-co@example.com', '', '', '']]),
    });
    const mapRow = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'company_profile' }).first();
    const migratedCompanyId = mapRow.entity_id;

    await t.trx('group_blocks').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      company_profile_id: migratedCompanyId,
      block_name: 'Rollback Sponsor Conference',
      start_date: '2027-09-01',
      end_date: '2027-09-03',
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused[0].entityType).toBe('company_profile');
    expect(await t.trx('company_profiles').where({ id: migratedCompanyId }).first()).toBeTruthy();
  });

  it('an unanticipated reference (not one of the explicit refuse-checks) is caught gracefully — one row is reported as refused rather than crashing the whole rollback request', async () => {
    const property = ctx.a.properties[0];
    // Both guests must already exist BEFORE the import — a reservations
    // import references an existing guest by contact, it never creates one
    // inline (this module's own deliberately-deferred scope).
    await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Un', last_name: 'Anticipated', email: 'unanticipated-block@example.com' });
    await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: 'Un', last_name: 'Anticipated', email: 'unanticipated-ok@example.com' });

    const importRunId = await importAndCommit({
      entityType: 'reservations',
      propertyId: property.id,
      fileContent: csv(
        ['guest_email', 'guest_phone', 'room_type_code', 'rate_code', 'arrival_date', 'departure_date', 'adults', 'children', 'status', 'room_number'],
        [
          ['unanticipated-block@example.com', '', 'DLX', 'BAR', '2027-10-01', '2027-10-02', '2', '0', '', ''],
          ['unanticipated-ok@example.com', '', 'DLX', 'BAR', '2027-10-05', '2027-10-06', '2', '0', '', ''],
        ]
      ),
    });

    const mapRows = await t.trx('imported_record_map').where({ import_run_id: importRunId, entity_type: 'reservation' }).orderBy('row_number');
    expect(mapRows.length).toBeGreaterThan(0);
    const blockedReservationId = mapRows[0].entity_id;

    // A real `notification_log` row referencing this reservation directly
    // — a real RESTRICT foreign key this module's own explicit refuse-
    // checks do not enumerate (deliberately: this test exists to prove the
    // try/catch safety net around each row's own rollback attempt, not to
    // exhaustively list every FK in the schema).
    await t.trx('notification_log').insert({
      tenant_id: ctx.a.id,
      property_id: property.id,
      recipient_email: 'unanticipated-block@example.com',
      template_key: 'reservation_confirmed',
      channel: 'email',
      status: 'sent',
      reservation_id: blockedReservationId,
    });

    const res = await rollback(importRunId);
    expect(res.status).toBe(200); // never a 500 — the exception is caught per-row, not left to escape
    expect(res.body.data.status).toBe('partially_rolled_back');
    expect(res.body.data.rowsRefused.some((row) => row.entityType === 'reservation' && String(row.entityId) === String(blockedReservationId))).toBe(true);
    expect(await t.trx('reservations').where({ id: blockedReservationId }).first()).toBeTruthy(); // left in place, not partially deleted

    // The OTHER row in the same run, genuinely untouched, still rolls back
    // normally — one row's unexpected failure does not abort the rest.
    const otherMapRow = mapRows[1];
    expect(res.body.data.rowsRolledBack).toBeGreaterThanOrEqual(1);
    expect(await t.trx('reservations').where({ id: otherMapRow.entity_id }).first()).toBeUndefined();
  });

  it('a run belonging to another tenant cannot be rolled back — plain 404', async () => {
    const importRunId = await importAndCommit({
      tenant: ctx.b,
      entityType: 'guests',
      fileContent: csv(['first_name', 'last_name', 'email', 'phone', 'date_of_birth'], [['B', 'Tenant', 'b-rollback@example.com', '', '']]),
    });

    const res = await rollback(importRunId, ctx.a);
    expect(res.status).toBe(404);
  });
});
