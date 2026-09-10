'use strict';

/**
 * HTTP-level tests for Group Blocks — PLAN.md Phase 4,
 * PRODUCT_REQUIREMENTS.md §3.8, TESTING.md GRP-1.
 *
 * Covers: block CRUD + RBAC, room-allocation upsert (single date and a
 * range), pickup computation against real reservations (including the
 * waitlisted/cancelled/no_show exclusions and over-pickup surfacing),
 * `createReservation` accepting/rejecting a `group_block_id`, `listReservations`
 * filtering by block, `generateInvoice`'s optional block scoping, bulk
 * `bill-to-sponsor` (every skip reason), and cross-tenant isolation.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Group Blocks (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex = 0, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return userId;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
    return userId;
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `gb-test-key-${idemCounter}`;
  }

  async function createCompany({ tenant = ctx.a, name = `GB Co ${Date.now()}-${Math.random()}` } = {}) {
    const res = await t.request
      .post('/api/v1/companies')
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .send({ name, billing_email: 'billing@gbco.example.com' });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function createArAccount({ tenant = ctx.a, companyProfileId, creditLimit = '10000.00' } = {}) {
    const res = await t.request
      .post('/api/v1/ar/accounts')
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .set('Idempotency-Key', idemKey())
      .send({ company_profile_id: companyProfileId, currency: 'NGN', credit_limit: creditLimit, enforcement_mode: 'flag_only' });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function createBlock({ tenant = ctx.a, blockName = `Block ${Date.now()}-${Math.random()}`, companyProfileId, startDate = '2027-03-10', endDate = '2027-03-13' } = {}) {
    const res = await t.request
      .post('/api/v1/group-blocks')
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .send({ block_name: blockName, company_profile_id: companyProfileId, start_date: startDate, end_date: endDate });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  function upsertAllocation(blockId, { tenant = ctx.a, roomTypeId, stayDate, startDate, endDate, roomsBlocked }) {
    return t.request
      .post(`/api/v1/group-blocks/${blockId}/rooms`)
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .send({ room_type_id: roomTypeId, stay_date: stayDate, start_date: startDate, end_date: endDate, rooms_blocked: roomsBlocked });
  }

  let reservationCounter = 0;
  async function createReservationDirect(tenant = ctx.a, { arrivalDate = '2027-03-10', departureDate = '2027-03-11', groupBlockId, status = 'confirmed' } = {}) {
    reservationCounter += 1;
    const [id] = await t.trx('reservations').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      guest_id: tenant.guests[0].id,
      room_type_id: tenant.roomTypes[0].id,
      rate_code_id: tenant.rateCodes[0].id,
      arrival_date: arrivalDate,
      departure_date: departureDate,
      adults: 1,
      children: 0,
      status,
      group_block_id: groupBlockId ?? null,
      confirmation_number: `GB-TEST-${reservationCounter}-${tenant.slug}`.toUpperCase().slice(0, 26),
    });
    await t.trx('reservation_daily_rates').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: id,
      stay_date: arrivalDate,
      rate: '100.00',
      currency: 'NGN',
    });
    return id;
  }

  let folioCounter = 0;
  async function openFolio(tenant, reservationId, { companyProfileId, status = 'open' } = {}) {
    folioCounter += 1;
    const [id] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: reservationId,
      folio_number: `GBF${String(folioCounter).padStart(6, '0')}`,
      status,
      balance: '0.00',
      currency: 'NGN',
      billed_to: companyProfileId ? 'Company (test)' : 'Guest',
      company_profile_id: companyProfileId ?? null,
    });
    return id;
  }

  // ====================================================================
  // Block CRUD + RBAC
  // ====================================================================

  describe('block CRUD', () => {
    it('a manager creates, lists, gets and updates a block', async () => {
      const created = await createBlock({ blockName: 'CRUD Retreat' });
      expect(created.status).toBe('active');
      expect(created.company_profile_id).toBeNull();

      const listRes = await t.request.get('/api/v1/group-blocks').set('Authorization', `Bearer ${tokenFor()}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((b) => String(b.id) === String(created.id))).toBe(true);

      const getRes = await t.request.get(`/api/v1/group-blocks/${created.id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.block_name).toBe('CRUD Retreat');

      const updateRes = await t.request
        .patch(`/api/v1/group-blocks/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ block_name: 'CRUD Retreat Renamed', status: 'cancelled' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.block_name).toBe('CRUD Retreat Renamed');
      expect(updateRes.body.data.status).toBe('cancelled');
    });

    it('the update allowlist ignores an unlisted field in the request body', async () => {
      const created = await createBlock({ blockName: 'Allowlist Retreat' });
      const res = await t.request
        .patch(`/api/v1/group-blocks/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ block_name: 'Allowlist Retreat Updated', tenant_id: ctx.b.id, id: '999999' });
      expect(res.status).toBe(200);
      expect(String(res.body.data.tenant_id)).toBe(String(ctx.a.id));
      expect(String(res.body.data.id)).toBe(String(created.id));
    });

    it('creating a block with a nonexistent company profile is rejected', async () => {
      const res = await t.request
        .post('/api/v1/group-blocks')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ block_name: 'Bad Sponsor', company_profile_id: '999999999', start_date: '2027-03-10', end_date: '2027-03-13' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_COMPANY_PROFILE_NOT_FOUND');
    });

    it('a front_desk user (group_blocks.view only) can read but not create a block', async () => {
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'front_desk' });
      const res = await t.request.post('/api/v1/group-blocks').set('Authorization', `Bearer ${tokenFor({ userId })}`).send({ block_name: 'x', start_date: '2027-03-10', end_date: '2027-03-11' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');

      const readRes = await t.request.get('/api/v1/group-blocks').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(readRes.status).toBe(200);

      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });

    it('a cashier user (group_blocks.view only) can read but not update a block', async () => {
      const created = await createBlock({ blockName: 'Cashier RBAC' });
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'cashier' });
      const res = await t.request.patch(`/api/v1/group-blocks/${created.id}`).set('Authorization', `Bearer ${tokenFor({ userId })}`).send({ block_name: 'nope' });
      expect(res.status).toBe(403);
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });

    it("a housekeeping user gets a real 403 even reading a block (holds neither key)", async () => {
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'housekeeping' });
      const res = await t.request.get('/api/v1/group-blocks').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(res.status).toBe(403);
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });

    it("another tenant's block is a real 404, never a 403", async () => {
      const res = await t.request.get(`/api/v1/group-blocks/${ctx.b.groupBlocks[0].id}`).set('Authorization', `Bearer ${tokenFor({ tenant: ctx.a })}`);
      expect(res.status).toBe(404);
    });
  });

  // ====================================================================
  // Room allocations
  // ====================================================================

  describe('room allocations', () => {
    it('upserts a single-date allocation and a range in one call, and re-upserting overwrites rather than duplicating', async () => {
      const block = await createBlock({ blockName: 'Allocation Block', startDate: '2027-04-01', endDate: '2027-04-05' });

      const singleRes = await upsertAllocation(block.id, { roomTypeId: ctx.a.roomTypes[0].id, stayDate: '2027-04-01', roomsBlocked: 5 });
      expect(singleRes.status).toBe(200);
      expect(singleRes.body.data).toHaveLength(1);
      expect(singleRes.body.data[0].rooms_blocked).toBe(5);

      const rangeRes = await upsertAllocation(block.id, { roomTypeId: ctx.a.roomTypes[0].id, startDate: '2027-04-01', endDate: '2027-04-04', roomsBlocked: 8 });
      expect(rangeRes.status).toBe(200);
      // expandStayDates is arrival-inclusive/departure-exclusive: 04-01, 04-02, 04-03.
      expect(rangeRes.body.data).toHaveLength(3);
      expect(rangeRes.body.data.every((row) => row.rooms_blocked === 8)).toBe(true);

      const listRes = await t.request.get(`/api/v1/group-blocks/${block.id}/rooms`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(listRes.status).toBe(200);
      // 04-01 was overwritten from 5 to 8, not duplicated — exactly 3 rows total for this room type.
      expect(listRes.body.data.filter((row) => String(row.room_type_id) === String(ctx.a.roomTypes[0].id))).toHaveLength(3);
      expect(listRes.body.data[0].room_type_code).toBeTruthy();
    });

    it('is rejected without either stay_date or a start/end range', async () => {
      const block = await createBlock({ blockName: 'Missing Date Block' });
      const res = await upsertAllocation(block.id, { roomTypeId: ctx.a.roomTypes[0].id, roomsBlocked: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });

    it('is rejected against a cancelled block', async () => {
      const block = await createBlock({ blockName: 'Cancel Then Allocate' });
      await t.request.patch(`/api/v1/group-blocks/${block.id}`).set('Authorization', `Bearer ${tokenFor()}`).send({ status: 'cancelled' });
      const res = await upsertAllocation(block.id, { roomTypeId: ctx.a.roomTypes[0].id, stayDate: '2027-03-10', roomsBlocked: 5 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_GROUP_BLOCK_CANCELLED');
    });

    it('a front_desk user cannot set an allocation', async () => {
      const block = await createBlock({ blockName: 'RBAC Allocation Block' });
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'front_desk' });
      const res = await t.request
        .post(`/api/v1/group-blocks/${block.id}/rooms`)
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .send({ room_type_id: ctx.a.roomTypes[0].id, stay_date: '2027-03-10', rooms_blocked: 5 });
      expect(res.status).toBe(403);
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });
  });

  // ====================================================================
  // Pickup — derived, never a stored counter
  // ====================================================================

  describe('pickup summary', () => {
    it('correctly reports blocked vs. picked-up, excluding waitlisted/cancelled/no_show', async () => {
      const block = await createBlock({ blockName: 'Pickup Block', startDate: '2027-05-01', endDate: '2027-05-03' });
      await upsertAllocation(block.id, { roomTypeId: ctx.a.roomTypes[0].id, stayDate: '2027-05-01', roomsBlocked: 4 });

      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-01', departureDate: '2027-05-02', groupBlockId: block.id, status: 'confirmed' });
      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-01', departureDate: '2027-05-02', groupBlockId: block.id, status: 'checked_in' });
      // These three must NOT count toward pickup.
      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-01', departureDate: '2027-05-02', groupBlockId: block.id, status: 'waitlisted' });
      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-01', departureDate: '2027-05-02', groupBlockId: block.id, status: 'cancelled' });
      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-01', departureDate: '2027-05-02', groupBlockId: block.id, status: 'no_show' });

      const res = await t.request.get(`/api/v1/group-blocks/${block.id}/pickup`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.totalRoomsBlocked).toBe(4);
      expect(res.body.data.totalRoomsPickedUp).toBe(2);
      const row = res.body.data.rows.find((r) => r.stayDate === '2027-05-01' && String(r.roomTypeId) === String(ctx.a.roomTypes[0].id));
      expect(row.roomsBlocked).toBe(4);
      expect(row.roomsPickedUp).toBe(2);
    });

    it('surfaces over-pickup on a night/room-type with no allocation rather than hiding it', async () => {
      const block = await createBlock({ blockName: 'Over-Pickup Block', startDate: '2027-05-10', endDate: '2027-05-12' });
      // No allocation row set at all for this room type/date.
      await createReservationDirect(ctx.a, { arrivalDate: '2027-05-10', departureDate: '2027-05-11', groupBlockId: block.id, status: 'confirmed' });

      const res = await t.request.get(`/api/v1/group-blocks/${block.id}/pickup`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      const row = res.body.data.rows.find((r) => r.stayDate === '2027-05-10');
      expect(row.roomsBlocked).toBe(0);
      expect(row.roomsPickedUp).toBe(1);
    });

    it('a pickup summary for a nonexistent block is a 404', async () => {
      const res = await t.request.get('/api/v1/group-blocks/999999999/pickup').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });
  });

  // ====================================================================
  // createReservation / listReservations integration
  // ====================================================================

  describe('reservation integration', () => {
    async function createReservationHttp({ groupBlockId, tenant = ctx.a, arrivalDate = '2027-06-01', departureDate = '2027-06-02' } = {}) {
      return t.request
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
        .set('Idempotency-Key', idemKey())
        .send({
          guest_id: String(tenant.guests[0].id),
          room_type_id: String(tenant.roomTypes[0].id),
          rate_code_id: String(tenant.rateCodes[0].id),
          arrival_date: arrivalDate,
          departure_date: departureDate,
          group_block_id: groupBlockId != null ? String(groupBlockId) : undefined,
        });
    }

    it('books a reservation tagged to an active block', async () => {
      const block = await createBlock({ blockName: 'Bookable Block' });
      const res = await createReservationHttp({ groupBlockId: block.id, arrivalDate: '2027-06-01', departureDate: '2027-06-02' });
      expect(res.status).toBe(201);
      expect(String(res.body.data.group_block_id)).toBe(String(block.id));
    });

    it('rejects a reservation tagged to a nonexistent block', async () => {
      const res = await createReservationHttp({ groupBlockId: '999999999', arrivalDate: '2027-06-03', departureDate: '2027-06-04' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_GROUP_BLOCK_NOT_FOUND');
    });

    it('rejects a reservation tagged to a cancelled block', async () => {
      const block = await createBlock({ blockName: 'Cancelled Booking Block' });
      await t.request.patch(`/api/v1/group-blocks/${block.id}`).set('Authorization', `Bearer ${tokenFor()}`).send({ status: 'cancelled' });
      const res = await createReservationHttp({ groupBlockId: block.id, arrivalDate: '2027-06-05', departureDate: '2027-06-06' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_GROUP_BLOCK_CANCELLED');
    });

    it('allows a reservation dated outside the block\'s own start/end range — tracking only, never a lock', async () => {
      const block = await createBlock({ blockName: 'Range Block', startDate: '2027-09-01', endDate: '2027-09-02' });
      const res = await createReservationHttp({ groupBlockId: block.id, arrivalDate: '2027-06-07', departureDate: '2027-06-08' }); // well outside the block's own range
      expect(res.status).toBe(201);
    });

    it('listReservations?group_block_id= filters correctly', async () => {
      const block = await createBlock({ blockName: 'Filter Block' });
      const other = await createBlock({ blockName: 'Other Filter Block' });
      const inBlock = await createReservationHttp({ groupBlockId: block.id, arrivalDate: '2027-06-10', departureDate: '2027-06-11' });
      expect(inBlock.status).toBe(201);
      const inOther = await createReservationHttp({ groupBlockId: other.id, arrivalDate: '2027-06-12', departureDate: '2027-06-13' });
      expect(inOther.status).toBe(201);

      const res = await t.request.get(`/api/v1/reservations?group_block_id=${block.id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((r) => String(r.id))).toEqual([String(inBlock.body.data.id)]);
    });
  });

  // ====================================================================
  // generateInvoice's optional block filter
  // ====================================================================

  describe('block-scoped invoicing', () => {
    it('scopes generated invoice lines to the block when group_block_id is supplied, and includes everything when omitted', async () => {
      const company = await createCompany();
      const account = await createArAccount({ companyProfileId: company.id });
      const block = await createBlock({ blockName: 'Invoice Block', companyProfileId: company.id });

      const inBlockReservation = await createReservationDirect(ctx.a, { arrivalDate: '2027-03-10', groupBlockId: block.id });
      const inBlockFolio = await openFolio(ctx.a, inBlockReservation, { companyProfileId: company.id });
      await t.trx('folio_line_items').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, folio_id: inBlockFolio,
        type: 'adjustment', description: 'In-block charge', amount: '40.00', currency: 'NGN', business_date: '2027-03-10',
      });

      const outOfBlockReservation = await createReservationDirect(ctx.a, { arrivalDate: '2027-03-10' }); // no group_block_id
      const outOfBlockFolio = await openFolio(ctx.a, outOfBlockReservation, { companyProfileId: company.id });
      await t.trx('folio_line_items').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, folio_id: outOfBlockFolio,
        type: 'adjustment', description: 'Out-of-block charge', amount: '65.00', currency: 'NGN', business_date: '2027-03-10',
      });

      const scopedRes = await t.request
        .post(`/api/v1/ar/accounts/${account.id}/invoices`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ group_block_id: block.id });
      expect(scopedRes.status).toBe(201);
      expect(scopedRes.body.data.total_amount).toBe('40.00');

      const unscopedRes = await t.request
        .post(`/api/v1/ar/accounts/${account.id}/invoices`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(unscopedRes.status).toBe(201);
      // Only the out-of-block charge is left un-invoiced now.
      expect(unscopedRes.body.data.total_amount).toBe('65.00');
    });
  });

  // ====================================================================
  // Bulk bill-to-sponsor
  // ====================================================================

  describe('bill-to-sponsor', () => {
    async function billToSponsor(blockId, { tenant = ctx.a } = {}) {
      return t.request
        .post(`/api/v1/group-blocks/${blockId}/bill-to-sponsor`)
        .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
        .set('Idempotency-Key', idemKey())
        .send({});
    }

    it('bills every eligible open folio to the sponsor and reports every skip reason', async () => {
      const company = await createCompany();
      await createArAccount({ companyProfileId: company.id });
      const block = await createBlock({ blockName: 'Billing Block', companyProfileId: company.id });

      const eligibleReservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });
      const eligibleFolio = await openFolio(ctx.a, eligibleReservation);

      const closedReservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });
      await openFolio(ctx.a, closedReservation, { status: 'closed' });

      const noFolioReservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });

      const alreadyBilledReservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });
      await openFolio(ctx.a, alreadyBilledReservation, { companyProfileId: company.id });

      const otherCompany = await createCompany({ name: 'Different Sponsor Co' });
      await createArAccount({ companyProfileId: otherCompany.id });
      const elsewhereReservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });
      await openFolio(ctx.a, elsewhereReservation, { companyProfileId: otherCompany.id });

      const res = await billToSponsor(block.id);
      expect(res.status).toBe(200);
      expect(res.body.data.billed).toEqual([String(eligibleFolio)]);
      const reasons = res.body.data.skipped.map((s) => s.reason).sort();
      expect(reasons).toEqual(['already_billed', 'already_billed_elsewhere', 'folio_not_open', 'no_open_folio']);

      const billedFolio = await t.trx('folios').where({ id: eligibleFolio }).first();
      expect(String(billedFolio.company_profile_id)).toBe(String(company.id));
    });

    it('replaying the same Idempotency-Key does not double-bill', async () => {
      const company = await createCompany();
      await createArAccount({ companyProfileId: company.id });
      const block = await createBlock({ blockName: 'Replay Billing Block', companyProfileId: company.id });
      const reservation = await createReservationDirect(ctx.a, { groupBlockId: block.id });
      const folio = await openFolio(ctx.a, reservation);

      const key = idemKey();
      const send = () =>
        t.request.post(`/api/v1/group-blocks/${block.id}/bill-to-sponsor`).set('Authorization', `Bearer ${tokenFor()}`).set('Idempotency-Key', key).send({});

      const first = await send();
      expect(first.status).toBe(200);
      expect(first.body.data.billed).toEqual([String(folio)]);

      const second = await send();
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
    });

    it('is rejected against an unsponsored block', async () => {
      const block = await createBlock({ blockName: 'Unsponsored Block' });
      const res = await billToSponsor(block.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_GROUP_BLOCK_NOT_SPONSORED');
    });

    it('is rejected when the sponsor has no active AR account', async () => {
      const company = await createCompany();
      const block = await createBlock({ blockName: 'No AR Account Block', companyProfileId: company.id });
      const res = await billToSponsor(block.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_AR_ACCOUNT_NOT_FOUND');
    });

    it('is rejected against a cancelled block', async () => {
      const company = await createCompany();
      await createArAccount({ companyProfileId: company.id });
      const block = await createBlock({ blockName: 'Cancelled Billing Block', companyProfileId: company.id });
      await t.request.patch(`/api/v1/group-blocks/${block.id}`).set('Authorization', `Bearer ${tokenFor()}`).send({ status: 'cancelled' });
      const res = await billToSponsor(block.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_GROUP_BLOCK_CANCELLED');
    });

    it('is gated on ar.manage, not group_blocks.manage — a group_blocks.manage-only role is refused', async () => {
      const company = await createCompany();
      await createArAccount({ companyProfileId: company.id });
      const block = await createBlock({ blockName: 'RBAC Billing Block', companyProfileId: company.id });
      // cashier holds neither group_blocks.manage nor ar.manage — confirms the gate is real, not a no-op.
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'cashier' });
      const res = await t.request
        .post(`/api/v1/group-blocks/${block.id}/bill-to-sponsor`)
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(res.status).toBe(403);
      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });
  });
});
