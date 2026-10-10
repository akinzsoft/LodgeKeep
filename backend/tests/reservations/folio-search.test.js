'use strict';

/**
 * Cashiering Folio Lookup by guest name / phone / room number
 * (`GET /front-desk/folio-search`, `service.searchFolios`).
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { classifyFolioSearch } = require('../../src/modules/reservations/service');

describe('Folio search (name / phone / room)', () => {
  const t = useTestApp();
  let ctx;
  let seq = 0;
  const day = '2026-08-29';

  const tokenFor = (tenant = ctx.a, userIndex = 0) =>
    signAccessToken({
      aud: 'staff',
      sub: String(tenant.users[userIndex].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  const idem = () => `fs-${(seq += 1)}-${Date.now()}`;
  const auth = (tok = tokenFor()) => ({ Authorization: `Bearer ${tok}` });

  let roomTypeId;
  let rateCodeId;

  async function checkedInGuest(tenant, { first, last, phone, room }) {
    const [guestId] = await t.trx('guests').insert({
      tenant_id: tenant.id,
      first_name: first,
      last_name: last,
      phone,
      email: `${first}.${last}.${seq}@fs.example.com`.toLowerCase(),
    });
    const [roomId] = await t.trx('rooms').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      room_type_id: roomTypeId,
      room_number: room,
      status: 'active',
      housekeeping_reported_status: 'clean',
    });
    const created = await t.request
      .post('/api/v1/reservations')
      .set(auth())
      .set('Idempotency-Key', idem())
      .send({
        guest_id: String(guestId),
        room_type_id: String(roomTypeId),
        rate_code_id: String(rateCodeId),
        arrival_date: day,
        departure_date: '2026-08-30',
      });
    expect(created.status).toBe(201);
    const res = await t.request
      .post(`/api/v1/reservations/${created.body.data.id}/check-in`)
      .set(auth())
      .set('Idempotency-Key', idem())
      .send({ room_id: String(roomId) });
    expect(res.status).toBe(200);
    return String(created.body.data.id);
  }

  const search = (q, tok) => t.request.get('/api/v1/front-desk/folio-search').query({ q }).set(auth(tok));

  let adaId;
  let chidiId;
  let leftId;
  let numericId;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: day });
    [roomTypeId] = await t.trx('room_types').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'FSRT',
      name: 'FSRT',
      default_occupancy: 2,
      base_rate: '100.00',
    });
    [rateCodeId] = await t.trx('rate_codes').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      code: 'FSRATE',
      base_rate: '50.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    adaId = await checkedInGuest(ctx.a, { first: 'Zuzu', last: 'Obiakor', phone: '0803 555 1212', room: 'FS07' });
    chidiId = await checkedInGuest(ctx.a, { first: 'Zuzu', last: 'Eze', phone: '+234 802 777 3434', room: 'FS08' });
    leftId = await checkedInGuest(ctx.a, { first: 'Zuzu', last: 'Gone', phone: '0805 999 0000', room: 'FS09' });
    numericId = await checkedInGuest(ctx.a, { first: 'Yaya', last: 'Num', phone: '0806 111 2222', room: '7' });
  });

  const ids = (res) => res.body.data.map((r) => String(r.id));

  it('classifies the query', () => {
    expect(classifyFolioSearch('a').kind).toBe('invalid');
    expect(classifyFolioSearch('07')).toMatchObject({ kind: 'text', couldBeName: false });
    expect(classifyFolioSearch('FS07')).toMatchObject({ kind: 'text', couldBeName: true });
    expect(classifyFolioSearch('0803 555 1212').kind).toBe('phone');
    expect(classifyFolioSearch('+234 803 555 1212').kind).toBe('phone');
    expect(classifyFolioSearch('Ada Obi')).toMatchObject({ kind: 'text', couldBeName: true });
  });

  it('finds by partial name, either word order, and returns what disambiguates', async () => {
    const res = await search('obia zuzu');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([adaId]);
    const row = res.body.data[0];
    expect(row.guest_first_name).toBe('Zuzu');
    expect(row.room_number).toBe('FS07');
    expect(row.arrival_date).toBeDefined();
    expect(row.folio_balance).toBe('0.00');

    const shared = await search('zuzu');
    expect(ids(shared)).toEqual(expect.arrayContaining([adaId, chidiId, leftId]));
  });

  it('finds by phone regardless of spaces, +234 or a leading 0', async () => {
    expect(ids(await search('08035551212'))).toEqual([adaId]);
    expect(ids(await search('+234 803 555 1212'))).toEqual([adaId]);
    expect(ids(await search('0802-777-3434'))).toEqual([chidiId]);
  });

  it('finds the current in-house guest by room number (case-insensitive)', async () => {
    expect(ids(await search('FS07'))).toEqual([adaId]);
    expect(ids(await search('fs08'))).toEqual([chidiId]);
  });

  it('finds a purely numeric room, ignoring leading zeros', async () => {
    expect(ids(await search('07'))).toEqual([numericId]);
    expect(ids(await search('7'))).toEqual([numericId]);
  });

  it('room search never returns a guest who has checked out of that room', async () => {
    await t.request
      .post(`/api/v1/reservations/${leftId}/check-out`)
      .set(auth())
      .set('Idempotency-Key', idem())
      .send({});
    expect(ids(await search('FS09'))).toEqual([]);
  });

  it('name/phone find a guest checked out in the last 7 days, but not an older checkout', async () => {
    expect(ids(await search('Gone'))).toContain(leftId);
    expect(ids(await search('0805 999 0000'))).toContain(leftId);

    await t.trx('reservations').where({ id: leftId }).update({ checked_out_at: new Date(Date.now() - 8 * 86400000) });
    expect(ids(await search('Gone'))).not.toContain(leftId);
  });

  it('returns nothing for a too-short query and caps results', async () => {
    expect((await search('z')).body.data).toEqual([]);
    expect((await search('   ')).body.data).toEqual([]);
  });

  it('does not treat % or _ in a name as wildcards', async () => {
    expect((await search('%%')).body.data).toEqual([]);
  });

  it('is gated by cashiering.post_charge: cashier allowed, housekeeping refused', async () => {
    const denied = await search('zuzu', tokenFor(ctx.a, 1));
    expect(denied.status).toBe(403);
  });

  it('never returns another tenant\'s guests', async () => {
    const res = await search('zuzu', tokenFor(ctx.b));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
