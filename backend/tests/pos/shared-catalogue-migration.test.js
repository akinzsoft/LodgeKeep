'use strict';

/**
 * The shared-catalogue migration's own pure decision functions
 * (20261108090000). Bug fix, found in production, not caught by CI: the
 * migration's own data merge inserts a new category row on whichever side
 * (menu/stock) is missing a name match — the ordinary case for real data
 * that predates the menu/stock category sync (every tenant that existed
 * before it) — and that insert used to fail outright, because outlet_id
 * was still NOT NULL at that point in the migration and the insert never
 * supplied one. CI's own fixture never exercised this path: its two
 * categories were always name-matched on both sides. Fixed by making
 * outlet_id nullable at the same point its own uniqueness and foreign key
 * are already being retired, right before the data merge runs, rather than
 * only at the very end.
 *
 * Mirrors `menu-category-outlet-migration.test.js`'s own precedent: the
 * DDL and the full data merge were run for real, up/down/up, against a
 * throwaway database seeded with data shaped exactly like the production
 * data that broke it — divergent menu/stock category names per outlet,
 * duplicate stock item names across outlets with real stock_movements,
 * per-outlet price/availability differences, a recipe link, and a stock
 * take line — not against jest's own shared per-file transaction (DDL
 * causes an implicit commit in MySQL, which would break that harness's own
 * rollback-at-the-end isolation). Confirmed correct: the two "House
 * Cocktail" items merged into one with the differing outlet's price and
 * sold-out state preserved as a per-outlet override; the two "Gin" stock
 * items merged with each outlet's real quantity (1000 + 200) correctly
 * attributed and totalled; the recipe link and the stock-take line both
 * still pointed at the right (now-shared) item; a pre-existing archived
 * duplicate was left alone, never revived or merged in.
 */

const { planOnePerOutlet, sumQuantities } = require('../../migrations/20261108090000_shared_pos_catalogue');

describe('planOnePerOutlet', () => {
  it('keeps at most one row per outlet in each set, grouping by arrival order', () => {
    const rows = [
      { id: 1, outlet_id: 10 },
      { id: 2, outlet_id: 20 },
      { id: 3, outlet_id: 10 }, // a second row at outlet 10 — must start a new set
    ];
    expect(planOnePerOutlet(rows)).toEqual([
      [rows[0], rows[1]],
      [rows[2]],
    ]);
  });

  it('one row alone is its own set', () => {
    const row = { id: 1, outlet_id: 5 };
    expect(planOnePerOutlet([row])).toEqual([[row]]);
  });
});

describe('sumQuantities', () => {
  it('sums exact 3-decimal quantity strings without floating-point error', () => {
    expect(sumQuantities(['0.100', '0.200'])).toBe('0.300');
    expect(sumQuantities(['1000.000', '200.000'])).toBe('1200.000');
  });

  it('handles negative quantities (a sale, a write-off)', () => {
    expect(sumQuantities(['100.000', '-30.000', '-5.000'])).toBe('65.000');
  });

  it('is 0.000 for an empty list', () => {
    expect(sumQuantities([])).toBe('0.000');
  });
});
