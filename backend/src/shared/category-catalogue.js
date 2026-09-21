'use strict';

/**
 * A shared implementation of the "registered category catalogue" shape this
 * codebase has built three times independently (POS menu categories, stock
 * item categories, expense categories) — byte-identical in every place the
 * three domains have no real reason to differ, explicitly parameterized
 * everywhere they do. See this file's own call sites (pos/service.js,
 * stock/service.js, expenses/service.js) for the three real configs.
 *
 * Real divergences expressed via config (never flattened):
 *   1. `optional` — whether the owning entity may omit a category at all
 *      (stock: yes; menu/expenses: no).
 *   2. `resolveMode` + `cascadeRename` — menu/stock store a COPIED NAME
 *      STRING on the owning entity (renaming cascades an UPDATE to every
 *      row using the old name); expenses stores a LIVE FK id (no cascade —
 *      the join always resolves the current name).
 *   3. `inUseChecks` — how many, and which, tables/columns/statuses count
 *      as "in use" for archive (menu/stock: one table; expenses: two).
 *   4. `errors.categoryNotFound`/`errors.categoryInUse` — each domain keeps
 *      its own exact error class/code/message/detail shape.
 *   5. `restrictListCountToRows` — whether the list view's per-row count
 *      query is pre-filtered to the ids/names being listed (expenses: yes)
 *      or scans every active child row unrestricted (menu/stock: yes) —
 *      provably identical OUTPUT either way, kept distinct anyway so no
 *      domain's actual SQL changes as a side effect of this refactor.
 *
 * Deliberately NOT parameterized, because reading all three real
 * implementations confirmed there is no actual divergence: the "name
 * required, ≤ N chars" validation message/code, the "sort_order must be a
 * whole number" validation, the literal duplicate-name message text, the
 * `sort_order ?? 0` default, and the listing order are byte-identical
 * across all three today. `nameMaxLength` stays configurable (default 60)
 * purely as a defensive affordance for a future 4th domain — not because
 * any of the three current ones actually vary it.
 */

const { scopedDb } = require('../db');
const { ValidationError, withDuplicateMapping } = require('./errors');

function keyFor(matchBy, value) {
  return matchBy === 'id' ? String(value) : String(value).trim().toLowerCase();
}

function cleanName(name, nameMaxLength) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > nameMaxLength) {
    throw new ValidationError('INVALID_CATEGORY_NAME', `A category name is required, up to ${nameMaxLength} characters.`, [
      { field: 'name', issue: trimmed ? 'too_long' : 'missing' },
    ]);
  }
  return trimmed;
}

function cleanSortOrder(sortOrder) {
  if (sortOrder === undefined) return undefined;
  if (!Number.isInteger(sortOrder)) {
    throw new ValidationError('INVALID_SORT_ORDER', '"sort_order" must be a whole number.', [{ field: 'sort_order', issue: 'invalid' }]);
  }
  return sortOrder;
}

/**
 * @param {object} config
 * @param {string} config.table - the registry table, e.g. 'pos_menu_categories'.
 * @param {number} [config.nameMaxLength=60]
 * @param {boolean} [config.optional=false] - only meaningful when resolveMode === 'name'.
 * @param {'name'|'id'} config.resolveMode
 * @param {{table: string, matchColumn: string} | null} config.cascadeRename
 * @param {Array<{table: string, matchColumn: string, matchBy: 'name'|'id', filter?: (query) => query}>} config.inUseChecks
 *   One entry per owning table checked on archive, IN THE ORDER the
 *   domain's own *CategoryInUseError constructor expects its count
 *   arguments (expenses: [expenses, recurring_expense_schedules]).
 *   inUseChecks[0] also drives the plain list view's own item_count,
 *   unless `listCountSource` overrides it (no current domain needs to).
 * @param {{table, matchColumn, matchBy, filter?}} [config.listCountSource] - defaults to inUseChecks[0].
 * @param {boolean} [config.restrictListCountToRows=false] - expenses: true.
 * @param {{categoryNotFound: () => Error, categoryInUse: (name, ...counts) => Error}} config.errors
 */
function createCategoryCatalogue(config) {
  const { table, resolveMode, cascadeRename, inUseChecks, errors } = config;
  const nameMaxLength = config.nameMaxLength ?? 60;
  const optional = config.optional ?? false;
  const listCountSource = config.listCountSource ?? inUseChecks[0];
  const restrictListCountToRows = config.restrictListCountToRows ?? false;

  async function listCategories({ context, includeArchived = false }) {
    const db = scopedDb().for(context);
    const query = db.table(table);
    const rows = await (includeArchived ? query : query.where({ status: 'active' })).orderBy('sort_order').orderBy('name');
    if (rows.length === 0) return rows;

    const { table: childTable, matchColumn, matchBy, filter } = listCountSource;
    let childQuery = db.table(childTable);
    if (restrictListCountToRows) {
      childQuery = childQuery.whereIn(matchColumn, rows.map((row) => (matchBy === 'id' ? row.id : row.name)));
    }
    if (filter) childQuery = filter(childQuery);
    const childRows = await childQuery.select(matchColumn);

    const countByKey = new Map();
    for (const child of childRows) {
      const value = child[matchColumn];
      if (!value) continue; // stock: a stock item's category may be null (optional).
      const key = keyFor(matchBy, value);
      countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
    }
    return rows.map((row) => ({
      ...row,
      item_count: countByKey.get(keyFor(matchBy, matchBy === 'id' ? row.id : row.name)) ?? 0,
    }));
  }

  async function getCategory({ context, id }) {
    const db = scopedDb().for(context);
    return db.table(table).where({ id }).first();
  }

  async function createCategory({ context, name, sortOrder }) {
    const db = scopedDb().for(context);
    const clean = cleanName(name, nameMaxLength);
    return withDuplicateMapping(table, `A category named "${clean}" already exists.`, async () => {
      const cleanSort = cleanSortOrder(sortOrder);
      const [id] = await db.table(table).insert({ name: clean, sort_order: cleanSort ?? 0 });
      return getCategory({ context, id });
    });
  }

  async function updateCategory({ context, id, name, sortOrder }) {
    const db = scopedDb().for(context);
    return withDuplicateMapping(table, `A category named "${typeof name === 'string' ? name.trim() : ''}" already exists.`, () =>
      db.transaction(async (trx) => {
        const category = await trx.table(table).where({ id }).forUpdate().first();
        if (!category) return null;
        const changes = {};
        if (name !== undefined) changes.name = cleanName(name, nameMaxLength);
        if (sortOrder !== undefined) changes.sort_order = cleanSortOrder(sortOrder);
        if (Object.keys(changes).length === 0) return category;
        await trx.table(table).where({ id }).update(changes);
        if (changes.name && changes.name !== category.name && cascadeRename) {
          await trx.table(cascadeRename.table).where({ [cascadeRename.matchColumn]: category.name }).update({ [cascadeRename.matchColumn]: changes.name });
        }
        return trx.table(table).where({ id }).first();
      })
    );
  }

  async function archiveCategory({ context, id }) {
    const db = scopedDb().for(context);
    return db.transaction(async (trx) => {
      const category = await trx.table(table).where({ id }).forUpdate().first();
      if (!category) return null;
      const counts = [];
      for (const check of inUseChecks) {
        const matchValue = check.matchBy === 'id' ? category.id : category.name;
        let query = trx.table(check.table).where({ [check.matchColumn]: matchValue });
        if (check.filter) query = check.filter(query);
        counts.push(await query.count());
      }
      if (counts.some((count) => count > 0)) {
        throw errors.categoryInUse(category.name, ...counts);
      }
      await trx.table(table).where({ id }).update({ status: 'archived' });
      return trx.table(table).where({ id }).first();
    });
  }

  async function resolveByName({ db, name }) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed && optional) return null;
    const category = trimmed ? await db.table(table).where({ name: trimmed, status: 'active' }).first() : null;
    if (!category) throw errors.categoryNotFound();
    return category.name;
  }

  async function resolveById({ db, id }) {
    const category = await db.table(table).where({ id, status: 'active' }).first();
    if (!category) throw errors.categoryNotFound();
    return category;
  }

  return {
    listCategories,
    getCategory,
    createCategory,
    updateCategory,
    archiveCategory,
    ...(resolveMode === 'name' ? { resolveByName } : { resolveById }),
  };
}

module.exports = { createCategoryCatalogue };
