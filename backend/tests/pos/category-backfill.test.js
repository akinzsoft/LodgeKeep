'use strict';

/**
 * 20261107090000_backfill_mirrored_menu_and_stock_categories: categories
 * that existed before menu and stock categories were kept in step get their
 * counterpart at the same outlet, once — never a duplicate (case-insensitive),
 * never a revived archived one, never at another outlet.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const backfill = require('../../migrations/20261107090000_backfill_mirrored_menu_and_stock_categories');

describe('menu/stock category backfill migration', () => {
  const t = useTestApp();
  let ctx;
  let outletId;
  let otherOutletId;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    outletId = ctx.a.posOutlets[0].id;
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, code: `BF-${Date.now()}`, name: 'Backfill shop', type: 'bar' });
    otherOutletId = id;
  });

  const base = () => ({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: outletId });

  it("copies each side's missing active categories across, at the same outlet, and nothing else", async () => {
    const tag = Date.now().toString(36);
    await t.trx('pos_menu_categories').insert({ ...base(), name: `MenuOnly ${tag}` });
    await t.trx('stock_item_categories').insert({ ...base(), name: `StockOnly ${tag}` });
    await t.trx('pos_menu_categories').insert({ ...base(), name: `Both ${tag}` });
    await t.trx('stock_item_categories').insert({ ...base(), name: `BOTH ${tag}` });
    await t.trx('pos_menu_categories').insert({ ...base(), name: `Archived ${tag}`, status: 'archived' });
    await t.trx('stock_item_categories').insert({ ...base(), name: `Kept ${tag}` });
    await t.trx('pos_menu_categories').insert({ ...base(), name: `Kept ${tag}`, status: 'archived' });

    await backfill.up(t.trx);
    await backfill.up(t.trx); // running twice changes nothing more

    const menu = await t.trx('pos_menu_categories').where({ outlet_id: outletId }).where('name', 'like', `% ${tag}`);
    const stock = await t.trx('stock_item_categories').where({ outlet_id: outletId }).where('name', 'like', `% ${tag}`);
    const summary = (rows) => rows.map((row) => `${row.name}:${row.status}`).sort();

    expect(summary(menu)).toEqual([`Archived ${tag}:archived`, `Both ${tag}:active`, `Kept ${tag}:archived`, `MenuOnly ${tag}:active`, `StockOnly ${tag}:active`].sort());
    expect(summary(stock)).toEqual([`BOTH ${tag}:active`, `Kept ${tag}:active`, `MenuOnly ${tag}:active`, `StockOnly ${tag}:active`].sort());
    expect(await t.trx('stock_item_categories').where({ outlet_id: otherOutletId }).where('name', 'like', `% ${tag}`)).toHaveLength(0);
  });
});
