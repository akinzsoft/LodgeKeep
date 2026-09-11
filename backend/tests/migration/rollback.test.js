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
