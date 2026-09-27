'use strict';

/**
 * GET /reservations — the Reservations tab's list (user-reported: it showed
 * only a 26-character confirmation code, oldest first, with no search).
 * Every row carries its guest and room type; `search`, `sort=newest` and
 * `limit`/`offset` are opt-in, so the dashboard's and Group Blocks' existing
 * calls behave exactly as before.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('GET /reservations — list, search, sort, paging', () => {
  const t = useTestApp();
  let ctx;
  const ids = {};

  function token(tenant = ctx.a) {
    return signAccessToken({ aud: 'staff', sub: String(tenant.users[0].id), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  }
  const list = (query = '', tenant = ctx.a) => t.request.get(`/api/v1/reservations${query}`).set('Authorization', `Bearer ${token(tenant)}`);

  async function guest(first, last, phone) {
    const [id] = await t.trx('guests').insert({ tenant_id: ctx.a.id, first_name: first, last_name: last, phone });
    return id;
  }

  async function reservation(guestId, confirmation, arrival, departure, status = 'confirmed') {
    const [id] = await t.trx('reservations').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      guest_id: guestId,
      room_type_id: ctx.a.roomTypes[0].id,
      rate_code_id: ctx.a.rateCodes[0].id,
      arrival_date: arrival,
      departure_date: departure,
      adults: 1,
      children: 0,
      status,
      confirmation_number: confirmation,
    });
    return id;
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    const ada = await guest('Ada', 'Obi', '08031112222');
    const tunde = await guest('Tunde', 'Bello', '07039998888');
    ids.early = await reservation(ada, 'LSTEARLYADA000000000000001', '2030-01-05', '2030-01-07');
    ids.late = await reservation(tunde, 'LSTLATETUNDE00000000000001', '2030-03-10', '2030-03-12', 'checked_out');
    ids.middle = await reservation(ada, 'LSTMIDDLEADA00000000000001', '2030-02-01', '2030-02-02', 'cancelled');
    await t.trx('folios').insert([
      { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, reservation_id: ids.early, folio_number: 'LSTFOLIO-A', status: 'open', balance: '150.50', currency: 'NGN' },
      { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, reservation_id: ids.early, folio_number: 'LSTFOLIO-B', status: 'open', balance: '49.50', currency: 'NGN' },
      { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, reservation_id: ids.late, folio_number: 'LSTFOLIO-C', status: 'closed', balance: '0.00', currency: 'NGN' },
    ]);
  });

  const confirmations = (res) => res.body.data.map((row) => row.confirmation_number).filter((c) => c.startsWith('LST'));

  it('keeps the original shape without paging: every row, arrival ascending — now with guest and room type', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(confirmations(res)).toEqual(['LSTEARLYADA000000000000001', 'LSTMIDDLEADA00000000000001', 'LSTLATETUNDE00000000000001']);
    const early = res.body.data.find((row) => row.id === String(ids.early) || String(row.id) === String(ids.early));
    expect(early).toMatchObject({ guest_first_name: 'Ada', guest_last_name: 'Obi', guest_phone: '08031112222', room_type_name: expect.any(String) });
    expect(early.folio_balance).toBeUndefined();
    expect(res.body.meta.total).toBeUndefined();
  });

  it('still filters by status', async () => {
    const res = await list('?status=cancelled');
    expect(confirmations(res)).toEqual(['LSTMIDDLEADA00000000000001']);
  });

  it('searches by guest name, phone or confirmation — every term must match', async () => {
    expect(confirmations(await list('?search=obi'))).toEqual(['LSTEARLYADA000000000000001', 'LSTMIDDLEADA00000000000001']);
    expect(confirmations(await list('?search=ada%20obi'))).toHaveLength(2);
    expect(confirmations(await list('?search=ada%20bello'))).toHaveLength(0);
    expect(confirmations(await list('?search=0703999'))).toEqual(['LSTLATETUNDE00000000000001']);
    expect(confirmations(await list('?search=LSTMIDDLE'))).toEqual(['LSTMIDDLEADA00000000000001']);
  });

  it('treats % and _ in a search literally', async () => {
    expect(confirmations(await list('?search=%25'))).toHaveLength(0);
  });

  it('pages newest first with the total, adding each row\'s open-folio balance', async () => {
    const first = await list('?search=LST&sort=newest&limit=2&offset=0');
    expect(first.status).toBe(200);
    expect(first.body.meta).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(confirmations(first)).toEqual(['LSTLATETUNDE00000000000001', 'LSTMIDDLEADA00000000000001']);
    // A closed folio is not an open balance.
    expect(first.body.data[0].folio_balance).toBeNull();

    const second = await list('?search=LST&sort=newest&limit=2&offset=2');
    expect(confirmations(second)).toEqual(['LSTEARLYADA000000000000001']);
    // Both open folios, summed exactly.
    expect(second.body.data[0]).toMatchObject({ folio_balance: '200.00', folio_currency: 'NGN' });
  });

  it('rejects a bad page size', async () => {
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=500')).status).toBe(400);
    expect((await list('?limit=10&offset=-1')).status).toBe(400);
  });

  it("never returns another tenant's reservations, even when searching", async () => {
    const res = await list('?search=LST&limit=50', ctx.b);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });
});
