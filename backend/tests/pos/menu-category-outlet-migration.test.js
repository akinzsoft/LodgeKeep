'use strict';

/**
 * The per-outlet menu category migration's decision for one existing row
 * (20261104090000). The DDL itself was run up/down/up against a copy of the
 * dev database; these pin the branches that data never reaches.
 */

const { planCategoryOutletFanOut } = require('../../migrations/20261104090000_add_outlet_id_to_pos_menu_categories');

describe('planCategoryOutletFanOut', () => {
  it('keeps the row on the one outlet whose items use it', () => {
    expect(planCategoryOutletFanOut([5], [2, 5, 9])).toEqual({ updateOutletId: 5, insertOutletIds: [] });
  });

  it('copies the row to every further outlet whose items use it, keeping the original on the lowest', () => {
    expect(planCategoryOutletFanOut([3, 7, 9], [3, 7, 9])).toEqual({ updateOutletId: 3, insertOutletIds: [7, 9] });
  });

  it('gives an unused category to the oldest outlet only, never to every outlet', () => {
    expect(planCategoryOutletFanOut([], [2, 6])).toEqual({ updateOutletId: 2, insertOutletIds: [] });
  });

  it('deletes a category at a property with no outlet at all', () => {
    expect(planCategoryOutletFanOut([], [])).toEqual({ delete: true });
  });
});
