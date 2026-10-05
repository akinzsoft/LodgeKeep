'use strict';

/**
 * Supermarket Stage 3 — bulk CSV product import (user-requested). One CSV row
 * is one product: a menu item (the thing the till sells, priced and
 * barcoded), a stock item with a 1:1 recipe link (so a sale deducts stock),
 * its category (created if new, carried at the supermarket outlet), and its
 * opening stock, received straight into the supermarket outlet (the receive
 * exemption supermarkets already have).
 *
 * Built on the Data Migration pipeline as the `supermarket_products` entity
 * type (`import_runs` / `import_row_errors` / `imported_record_map`), with
 * these confirmed rules (all user-decided):
 *
 * - ALL-OR-NOTHING. The whole file commits in one transaction, or nothing
 *   does: a half-imported catalogue with half its opening stock is worse
 *   than none. A dry run with any blocking error refuses the commit.
 * - CREATE-ONLY. A barcode already registered, or an active product with the
 *   same name in the same category, is an error — the import never edits an
 *   existing product's price or stock.
 * - A category already carried by any active selling outlet that is not a
 *   supermarket is an error (a store room carrying it does not count — it
 *   holds stock, it never sells): with the shared catalogue an outlet sells every item in every
 *   category it carries, so filing mart products under the Bar's "Drinks"
 *   would put them on the Bar's menu and the Bar's cocktails on the mart's.
 * - `cost_price` is required whenever `opening_stock` is above zero, so no
 *   opening stock is ever recorded at ₦0.00 (every margin report would show
 *   that product as pure profit).
 * - One committing product import per property at a time — the unique index
 *   on `import_runs.committing_products_property_id`, never a lock on
 *   anything the till uses.
 * - Undo deletes, per product, only what nobody has touched since the import
 *   (no sale, no stock movement other than the import's own receipt, the
 *   same barcodes, the same recipe). The import's own `IMPORT-<run>`
 *   receipt is deleted with it — a deliberate, scoped exception to "the
 *   stock ledger is never edited": nothing else references that movement.
 *   Price/name/availability edits and archiving do not block undo.
 *
 * Validation is one pure function (`validateProducts`) over the parsed rows
 * and a snapshot of the catalogue (`loadWorld`), used by the dry run and
 * again inside the commit transaction — never two copies of the rules.
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { scopedDb } = require('../../db');
const { workerContext } = require('../tenancy');
const { parseImportFile } = require('../migration/parse');
const { columnsForEntityType } = require('../migration/templates');
const { recordAuditEntry } = require('../../audit');
const { sumQuantity, compareQuantity } = require('../../shared/quantity');
const { compareMoney } = require('../../shared/money');
const { isSupermarketOutlet, isHotelSellingOutlet } = require('../../shared/outlet-types');
const posService = require('../pos/service');
const stockService = require('../stock/service');
const menuImages = require('../pos/menu-images');
const { InvalidImportRunStateError } = require('../migration/errors');
const { cleanBarcode } = require('./service');
const errors = require('./errors');

const ENTITY_TYPE = 'supermarket_products';
const COLUMNS = columnsForEntityType(ENTITY_TYPE); // migration/templates.js holds every import's column list
const REQUIRED_COLUMNS = Object.freeze(['name', 'category', 'price']);
const EXAMPLE_ROW = Object.freeze(['Coca-Cola 50cl', 'Mart Drinks', '500.00', '5449000000996|5449000131805', 'bottle', '380.00', '48', '12', 'NBC']);
const MAX_PRODUCT_ROWS = 5000;
const BARCODE_SEPARATOR = '|';
const DEFAULT_UNIT = 'pcs';
const RECIPE_QUANTITY = '1.000';
const MAX = { name: 150, category: 60, unit: 30, supplier: 150 };
const MONEY = /^\d{1,10}(\.\d{1,2})?$/; // DECIMAL(12,2)
// A numeric barcode column that went through Excel comes out as 5.449E+12 — the real digits are gone.
const SCIENTIFIC = /^\d+(\.\d+)?e[+-]?\d+$/i;
/** How many findings of each severity a run's GET/dry-run response carries; the rest are counted, not sent (a 5,000-row file can have 10,000 warnings). */
const MAX_FINDINGS_SHOWN = 300;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/; // DECIMAL(14,3)
const INSERT_CHUNK = 500;

/**
 * Every table with a foreign key to `pos_menu_items` / `stock_items`, and
 * how undo treats it. Pinned against information_schema by a test, so a
 * future migration adding a reference fails CI until undo handles it.
 * (`supermarket_sale_lines.menu_item_id` is a plain column, not a foreign
 * key, and is checked as well.)
 */
const MENU_ITEM_REFERENCE_TABLES = Object.freeze({
  pos_order_items: 'refuse',
  pos_menu_item_components: 'compare',
  supermarket_barcodes: 'compare',
  pos_outlet_menu_items: 'delete',
});
const STOCK_ITEM_REFERENCE_TABLES = Object.freeze({
  stock_movements: 'refuse_except_import_receipt',
  stock_take_lines: 'refuse',
  stock_transfer_request_lines: 'refuse',
  pos_menu_item_components: 'compare',
  stock_levels: 'delete',
});

/** Matches the database's case- and accent-insensitive collation (utf8mb4_0900_ai_ci), so "Cafe" and "Café" are one name here as they are to the unique keys. */
function keyOf(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // combining marks only (the accents NFD split off)
    .trim()
    .toLowerCase();
}
function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}
function importReference(runId) {
  return `IMPORT-${runId}`;
}
function templateCsv() {
  return `${COLUMNS.join(',')}\n${EXAMPLE_ROW.join(',')}\n`;
}

/**
 * Reads the file and checks it is this import's template: the required
 * columns present, no unknown column (a typo like "barcode" would otherwise
 * silently drop every barcode), between 1 and 5,000 data rows.
 */
function readProductFile(filePath) {
  const rows = parseImportFile(filePath);
  if (rows.length === 0) throw new errors.ProductImportFileError('The file has no product rows under the header.');
  if (rows.length > MAX_PRODUCT_ROWS) {
    throw new errors.ProductImportFileError(`The file has ${rows.length} product rows; at most ${MAX_PRODUCT_ROWS} can be imported at once. Split it into smaller files.`, {
      maxRows: MAX_PRODUCT_ROWS,
    });
  }
  const header = Object.keys(rows[0]).filter((column) => column !== '__rowNumber');
  const normalised = header.map((column) => column.trim().toLowerCase());
  // Two columns with the same name (in any case) would silently overwrite one another — the parser keeps only the last.
  const [rawHeader = []] = parse(fs.readFileSync(filePath, 'utf8'), { bom: true, trim: true, to: 1 });
  const rawNormalised = rawHeader.map((column) => String(column).trim().toLowerCase());
  const repeated = [...new Set(rawNormalised.filter((column, index) => rawNormalised.indexOf(column) !== index))];
  if (repeated.length) {
    throw new errors.ProductImportFileError(`The column(s) ${repeated.join(', ')} appear more than once in the header. Keep one of each.`, { repeated });
  }
  const missing = REQUIRED_COLUMNS.filter((column) => !normalised.includes(column));
  const unknown = header.filter((column, index) => !COLUMNS.includes(normalised[index]));
  if (missing.length || unknown.length) {
    const parts = [];
    if (missing.length) parts.push(`missing column(s): ${missing.join(', ')}`);
    if (unknown.length) parts.push(`unknown column(s): ${unknown.join(', ')}`);
    throw new errors.ProductImportFileError(`This is not the product import template (${parts.join('; ')}). The columns are: ${COLUMNS.join(', ')}.`, {
      missing,
      unknown,
      expected: COLUMNS,
    });
  }
  // Re-key every row by the template's own column names (headers may differ in case/spacing).
  return rows.map((row) => {
    const out = { __rowNumber: row.__rowNumber };
    header.forEach((column, index) => {
      out[normalised[index]] = row[column];
    });
    return out;
  });
}

// ---------------------------------------------------------------- format

/** One row's format checks — pure. Returns `{ product, problems }`; `product` holds the cleaned values. */
function parseProductRow(row) {
  const problems = [];
  const fail = (column, message) => problems.push({ column, message });

  const name = text(row.name);
  if (!name) fail('name', 'The product name is required.');
  else if (name.length > MAX.name) fail('name', `The product name is longer than ${MAX.name} characters.`);

  const category = text(row.category);
  if (!category) fail('category', 'The category is required.');
  else if (category.length > MAX.category) fail('category', `The category is longer than ${MAX.category} characters.`);

  const price = text(row.price);
  if (!price) fail('price', 'The price is required.');
  else if (!MONEY.test(price)) fail('price', `"${price}" is not a price — use a number with at most 2 decimals, e.g. 500.00.`);

  const barcodes = [];
  const seenInRow = new Set();
  for (const raw of text(row.barcodes).split(BARCODE_SEPARATOR).map((part) => part.trim()).filter(Boolean)) {
    if (SCIENTIFIC.test(raw)) {
      fail('barcodes', `"${raw}" looks like a number Excel shortened (scientific notation), so the real barcode is lost. Format the barcodes column as Text and type them again.`);
      continue;
    }
    let barcode;
    try {
      barcode = cleanBarcode(raw);
    } catch (error) {
      fail('barcodes', `"${raw}": ${error.message}`);
      continue;
    }
    if (seenInRow.has(keyOf(barcode))) {
      fail('barcodes', `The barcode "${barcode}" is listed twice on this row.`);
      continue;
    }
    seenInRow.add(keyOf(barcode));
    barcodes.push(barcode);
  }

  const unit = text(row.unit) || DEFAULT_UNIT;
  if (unit.length > MAX.unit) fail('unit', `The unit is longer than ${MAX.unit} characters.`);

  const costPrice = text(row.cost_price);
  if (costPrice && !MONEY.test(costPrice)) fail('cost_price', `"${costPrice}" is not a cost — use a number with at most 2 decimals.`);

  const openingStock = text(row.opening_stock);
  if (openingStock && !QUANTITY.test(openingStock)) fail('opening_stock', `"${openingStock}" is not a quantity — use a number of 0 or more with at most 3 decimals.`);
  const hasOpeningStock = Boolean(openingStock) && QUANTITY.test(openingStock) && compareQuantity(openingStock, '0') > 0;
  if (hasOpeningStock && (!costPrice || (MONEY.test(costPrice) && compareMoney(costPrice, '0') <= 0))) {
    fail('cost_price', 'A cost price above zero is required when there is opening stock, so the stock is not recorded at zero cost.');
  }

  const reorderLevel = text(row.reorder_level);
  if (reorderLevel && !QUANTITY.test(reorderLevel)) fail('reorder_level', `"${reorderLevel}" is not a quantity — use a number of 0 or more with at most 3 decimals.`);

  const supplier = text(row.supplier);
  if (supplier.length > MAX.supplier) fail('supplier', `The supplier is longer than ${MAX.supplier} characters.`);

  return {
    problems,
    product: {
      rowNumber: row.__rowNumber,
      name,
      category,
      price,
      barcodes,
      unit,
      costPrice: costPrice || null,
      openingStock: hasOpeningStock ? sumQuantity([openingStock]) : null,
      reorderLevel: reorderLevel && QUANTITY.test(reorderLevel) ? sumQuantity([reorderLevel]) : null,
      supplier: supplier || null,
    },
  };
}

// ---------------------------------------------------------------- world snapshot

/** Everything the rules compare against, read through `db` (the dry run's accessor, or the commit transaction). */
async function loadWorld({ db, outletId, propertyId }) {
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  const property = await db.table('properties').where({ id: propertyId }).first('current_business_date');

  const barcodeRows = await db
    .table('supermarket_barcodes')
    .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'supermarket_barcodes.menu_item_id'))
    .select('supermarket_barcodes.barcode', 'pos_menu_items.name', 'pos_menu_items.category');
  const barcodes = new Map(barcodeRows.map((row) => [keyOf(row.barcode), row]));

  const items = await db.table('pos_menu_items').where({ status: 'active' }).select('name', 'category');
  const activeProducts = new Set(items.map((row) => `${keyOf(row.name)}::${keyOf(row.category)}`));

  const categoryRows = await db.table('pos_menu_categories').select('id', 'name', 'status');
  const categories = new Map(categoryRows.map((row) => [keyOf(row.name), row]));

  const stockCategoryRows = await db.table('stock_item_categories').select('name', 'status');
  const stockCategories = new Map(stockCategoryRows.map((row) => [keyOf(row.name), row]));

  const carries = await db
    .table('pos_outlet_categories')
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'pos_outlet_categories.outlet_id'))
    .select('pos_outlet_categories.category_id', 'pos_outlets.id as outlet_id', 'pos_outlets.name as outlet_name', 'pos_outlets.type', 'pos_outlets.status');
  const carriers = new Map();
  for (const carry of carries) {
    const key = String(carry.category_id);
    if (!carriers.has(key)) carriers.set(key, []);
    carriers.get(key).push(carry);
  }

  const stockItems = await db.table('stock_items').where({ status: 'active' }).select('name');
  const stockItemNames = new Set(stockItems.map((row) => keyOf(row.name)));

  return { outlet, businessDate: property?.current_business_date ?? null, barcodes, activeProducts, categories, stockCategories, carriers, stockItemNames };
}

// ---------------------------------------------------------------- the rules

/**
 * Pure. Returns `{ products, findings, errorRows, summary }`. `findings` are
 * import_row_errors-shaped (`severity` 'error' blocks, 'warning' does not).
 * `products` carry the canonical category spelling (the registered one, or
 * the first spelling in the file) and whether the category is new.
 */
function validateProducts({ rows, world }) {
  const findings = [];
  const add = (rowNumber, column, severity, message) => findings.push({ row_number: rowNumber, column_name: column, severity, message: message.slice(0, 500) });

  const parsed = rows.map((row) => parseProductRow(row));
  for (const { problems, product } of parsed) for (const p of problems) add(product.rowNumber, p.column, 'error', p.message);

  if (!world.outlet || world.outlet.status !== 'active' || !isSupermarketOutlet(world.outlet)) {
    for (const { product } of parsed) add(product.rowNumber, null, 'error', 'The outlet is no longer an active supermarket outlet.');
  }

  // Canonical category spelling: the registered one, else the first seen in the file.
  const firstSpelling = new Map();
  for (const { product } of parsed) {
    if (product.category && !firstSpelling.has(keyOf(product.category))) firstSpelling.set(keyOf(product.category), product.category);
  }

  const rowsByBarcode = new Map();
  const rowsByProduct = new Map();
  for (const { product } of parsed) {
    for (const barcode of product.barcodes) {
      const key = keyOf(barcode);
      if (!rowsByBarcode.has(key)) rowsByBarcode.set(key, []);
      rowsByBarcode.get(key).push(product.rowNumber);
    }
    if (product.name && product.category) {
      const key = `${keyOf(product.name)}::${keyOf(product.category)}`;
      if (!rowsByProduct.has(key)) rowsByProduct.set(key, []);
      rowsByProduct.get(key).push(product.rowNumber);
    }
  }
  const others = (list, self) => list.filter((n) => n !== self).join(', ');

  const products = [];
  for (const { product } of parsed) {
    const n = product.rowNumber;

    for (const barcode of product.barcodes) {
      const sameFile = rowsByBarcode.get(keyOf(barcode));
      if (sameFile.length > 1) add(n, 'barcodes', 'error', `The barcode "${barcode}" is also on row(s) ${others(sameFile, n)} of this file.`);
      const existing = world.barcodes.get(keyOf(barcode));
      if (existing) add(n, 'barcodes', 'error', `The barcode "${barcode}" already belongs to "${existing.name}" (${existing.category}).`);
    }

    let canonicalCategory = product.category;
    let categoryIsNew = false;
    if (product.name && product.category) {
      const sameFile = rowsByProduct.get(`${keyOf(product.name)}::${keyOf(product.category)}`);
      if (sameFile.length > 1) add(n, 'name', 'error', `"${product.name}" in "${product.category}" is also on row(s) ${others(sameFile, n)} of this file.`);
      if (world.activeProducts.has(`${keyOf(product.name)}::${keyOf(product.category)}`)) {
        add(n, 'name', 'error', `A product "${product.name}" already exists in "${product.category}". This import only creates new products — remove the row.`);
      }

      const category = world.categories.get(keyOf(product.category));
      if (category) {
        canonicalCategory = category.name;
        if (category.status !== 'active') {
          add(n, 'category', 'error', `The category "${category.name}" is archived. Restore it in Setup, or use another category name.`);
        }
        // Selling outlets only: a store room carries categories to hold their stock, never to sell them.
        const sharedWith = (world.carriers.get(String(category.id)) ?? []).filter(isHotelSellingOutlet);
        if (sharedWith.length) {
          const names = [...new Set(sharedWith.map((c) => c.outlet_name))].join(', ');
          add(n, 'category', 'error', `"${category.name}" is sold at ${names} — use a supermarket category name such as "Mart ${category.name}".`);
        }
      } else {
        canonicalCategory = firstSpelling.get(keyOf(product.category));
        categoryIsNew = true;
      }
      // The stock list mirrors the menu list by name; an archived stock twin cannot file the new stock item.
      const stockCategory = world.stockCategories.get(keyOf(product.category));
      if (stockCategory && stockCategory.status !== 'active') {
        add(n, 'category', 'error', `The stock category "${stockCategory.name}" is archived. Restore it in Stock, or use another category name.`);
      }
    }

    if (product.openingStock && !world.businessDate) {
      add(n, 'opening_stock', 'error', 'The property has no current business date, so opening stock cannot be dated. Set it in Setup first.');
    }

    if (product.barcodes.length === 0) add(n, 'barcodes', 'warning', 'No barcode — this product cannot be scanned. You can add one later from the till\'s setup panel.');
    if (!product.openingStock) add(n, 'opening_stock', 'warning', 'No opening stock — the product can be sold once, then switches off until stock is received.');
    if (product.name && world.stockItemNames.has(keyOf(product.name))) {
      add(n, 'name', 'warning', `A stock item named "${product.name}" already exists; this import creates a separate one for the supermarket.`);
    }

    products.push({ ...product, category: canonicalCategory, categoryIsNew });
  }

  const errorRows = new Set(findings.filter((f) => f.severity === 'error').map((f) => f.row_number));
  const newCategories = new Set(products.filter((p) => p.categoryIsNew).map((p) => keyOf(p.category)));
  const summary = {
    products: products.length,
    categoriesToCreate: newCategories.size,
    barcodes: products.reduce((sum, p) => sum + p.barcodes.length, 0),
    productsWithOpeningStock: products.filter((p) => p.openingStock).length,
    openingStockUnits: sumQuantity(products.map((p) => p.openingStock).filter(Boolean)),
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
  return { products, findings, errorRows, summary };
}

// ---------------------------------------------------------------- dry run

/** The run's own property-pinned accessor (a run may be read by a user whose active property is different). */
function runDb(tenantId, run) {
  return scopedDb().for(workerContext({ tenantId, propertyId: run.property_id }));
}

async function replaceFindings(db, importRunId, findings) {
  await db.table('import_row_errors').where({ import_run_id: importRunId }).delete();
  for (let i = 0; i < findings.length; i += INSERT_CHUNK) {
    await db.table('import_row_errors').insert(findings.slice(i, i + INSERT_CHUNK).map((f) => ({ import_run_id: importRunId, ...f })));
  }
}

const DRY_RUNNABLE = ['uploaded', 'dry_run_complete'];

/**
 * Writes nothing but the run's findings and predicted counts. Returns the
 * summary. The findings and status are written under a lock on the run row,
 * re-checking its status there: a commit that claimed the run meanwhile is
 * never reset to "checked" (which would free the one-per-property slot
 * while its job runs) nor has its findings replaced.
 */
async function dryRunProducts({ context, run }) {
  const db = runDb(context.tenantId, run);
  const rows = readProductFile(run.file_path);
  const world = await loadWorld({ db, outletId: run.outlet_id, propertyId: run.property_id });
  const { findings, errorRows, summary } = validateProducts({ rows, world });
  await db.transaction(async (trx) => {
    const locked = await trx.table('import_runs').where({ id: run.id }).forUpdate().first('status');
    if (!DRY_RUNNABLE.includes(locked.status)) throw new InvalidImportRunStateError(locked.status, DRY_RUNNABLE);
    await replaceFindings(trx, run.id, findings);
    await trx.table('import_runs').where({ id: run.id }).update({
      status: 'dry_run_complete',
      rows_total: rows.length,
      rows_created: rows.length - errorRows.size,
      rows_skipped: errorRows.size,
    });
  });
  return summary;
}

/**
 * At most MAX_FINDINGS_SHOWN findings of each severity, plus the full counts
 * — what a response carries (the full list stays stored).
 */
function limitFindings(findings) {
  const errorsOnly = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return {
    errors: [...errorsOnly.slice(0, MAX_FINDINGS_SHOWN), ...warnings.slice(0, MAX_FINDINGS_SHOWN)],
    findingCounts: { errors: errorsOnly.length, warnings: warnings.length, shownPerKind: MAX_FINDINGS_SHOWN },
  };
}

/**
 * The summary shown for a run: predicted (from the file) until it commits,
 * then what really exists from it (from imported_record_map).
 */
async function summarizeRun({ context, run }) {
  const db = runDb(context.tenantId, run);
  if (['uploaded', 'dry_run_complete'].includes(run.status)) {
    try {
      const rows = readProductFile(run.file_path);
      const world = await loadWorld({ db, outletId: run.outlet_id, propertyId: run.property_id });
      return { kind: 'predicted', ...validateProducts({ rows, world }).summary };
    } catch (error) {
      return { kind: 'unavailable', message: error.message };
    }
  }
  const mapRows = await db.table('imported_record_map').where({ import_run_id: run.id }).select('entity_type');
  const count = (type) => mapRows.filter((row) => row.entity_type === type).length;
  return { kind: 'imported', products: count('menu_item'), categoriesCreated: count('menu_category') };
}

// ---------------------------------------------------------------- commit

/**
 * The whole file, in the caller's one transaction (`trx`, pinned to the
 * run's property). Re-validates against the catalogue as the transaction
 * sees it and throws `ProductImportChangedError` (nothing written) if the
 * data changed since the dry run. Marks the run completed in the same
 * transaction, so "committed" and "recorded as committed" can never differ.
 */
async function commitProducts({ trx, context, run }) {
  const rows = readProductFile(run.file_path);
  const world = await loadWorld({ db: trx, outletId: run.outlet_id, propertyId: run.property_id });
  const { products, findings } = validateProducts({ rows, world });
  const blocking = findings.filter((f) => f.severity === 'error');
  if (blocking.length) throw new errors.ProductImportChangedError(blocking);

  const outletId = run.outlet_id;
  const mapRows = [];

  // Categories first (a new menu category registers its stock twin itself), carried at the outlet.
  const categoryRowIntroduced = new Map();
  for (const product of products) {
    if (product.categoryIsNew && !categoryRowIntroduced.has(keyOf(product.category))) categoryRowIntroduced.set(keyOf(product.category), product);
  }
  for (const product of categoryRowIntroduced.values()) {
    const category = await posService.createMenuCategory({ context, db: trx, name: product.category, outletIds: [outletId] });
    mapRows.push({ row_number: product.rowNumber, entity_type: 'menu_category', entity_id: category.id });
  }
  // Every stock-list twin this import registers (the menu create mirrors one when none exists; an existing menu
  // category may lack one, from before the lists were mirrored) is recorded, so undo removes only what it made.
  const firstRowByCategory = new Map();
  for (const product of products) if (!firstRowByCategory.has(keyOf(product.category))) firstRowByCategory.set(keyOf(product.category), product);
  for (const [key, product] of firstRowByCategory) {
    if (world.stockCategories.has(key)) continue;
    const stockCategory = product.categoryIsNew
      ? await trx.table('stock_item_categories').where({ name: product.category }).first('id')
      : await stockService.createStockItemCategory({ context, db: trx, name: product.category });
    mapRows.push({ row_number: product.rowNumber, entity_type: 'stock_category', entity_id: stockCategory.id });
  }

  const receiptLines = [];
  for (const product of products) {
    const menuItem = await posService.createMenuItem({
      context,
      db: trx,
      outletId,
      name: product.name,
      category: product.category,
      price: product.price,
      costPrice: product.costPrice,
    });
    for (const barcode of product.barcodes) await trx.table('supermarket_barcodes').insert({ menu_item_id: menuItem.id, barcode });
    const stockItem = await stockService.createStockItem({
      context,
      db: trx,
      outletId,
      name: product.name,
      unit: product.unit,
      category: product.category,
      purchaseCost: product.costPrice ?? '0.00',
      supplier: product.supplier,
      reorderLevel: product.reorderLevel ?? undefined,
    });
    await stockService.upsertMenuItemComponents({ context, db: trx, menuItemId: menuItem.id, components: [{ stockItemId: stockItem.id, quantity: RECIPE_QUANTITY }] });
    mapRows.push({ row_number: product.rowNumber, entity_type: 'menu_item', entity_id: menuItem.id });
    mapRows.push({ row_number: product.rowNumber, entity_type: 'stock_item', entity_id: stockItem.id });
    if (product.openingStock) receiptLines.push({ stockItemId: stockItem.id, quantity: product.openingStock, unitCost: product.costPrice });
  }

  if (receiptLines.length) {
    await stockService.recordGoodsReceived({
      trx,
      outletId,
      lines: receiptLines,
      reference: importReference(run.id),
      userId: run.run_by_user_id,
      businessDate: world.businessDate,
    });
  }

  for (let i = 0; i < mapRows.length; i += INSERT_CHUNK) {
    await trx.table('imported_record_map').insert(mapRows.slice(i, i + INSERT_CHUNK).map((row) => ({ import_run_id: run.id, created: true, ...row })));
  }

  const result = {
    products: products.length,
    categoriesCreated: categoryRowIntroduced.size,
    barcodes: products.reduce((sum, p) => sum + p.barcodes.length, 0),
    productsWithOpeningStock: receiptLines.length,
    openingStockUnits: sumQuantity(receiptLines.map((line) => line.quantity)),
  };
  await recordAuditEntry(trx, {
    propertyId: run.property_id,
    entityType: 'import_runs',
    entityId: run.id,
    action: 'supermarket_products_import',
    userId: run.run_by_user_id,
    source: 'job',
    afterState: { outletId: String(outletId), reference: importReference(run.id), ...result },
  });
  // Guarded: a run released as stuck (failed) while this job was still going must not also land as completed.
  const marked = await trx
    .table('import_runs')
    .where({ id: run.id, status: 'committing' })
    .update({ status: 'completed', rows_created: products.length, rows_skipped: 0, completed_at: new Date() });
  if (!marked) throw new errors.ProductImportReleasedError();
  return result;
}

// ---------------------------------------------------------------- undo

/** Why one imported product cannot be removed, or null when it is untouched. `trx` holds both rows locked. */
async function refusalFor({ trx, run, menuItemId, stockItemId, expectedBarcodes }) {
  const sold = await trx.table('pos_order_items').where({ menu_item_id: menuItemId }).first('id');
  if (sold) return 'It has been sold (or rung on a tab) since the import.';
  const soldAtTill = await trx.table('supermarket_sale_lines').where({ menu_item_id: menuItemId }).first('id');
  if (soldAtTill) return 'It has been sold at the till since the import.';

  const movements = await trx.table('stock_movements').where({ stock_item_id: stockItemId }).select('type', 'reference');
  if (movements.some((m) => !(m.type === 'received' && m.reference === importReference(run.id)))) return 'Its stock has moved since the import.';
  const counted = await trx.table('stock_take_lines').where({ stock_item_id: stockItemId }).first('id');
  if (counted) return 'It is on a stock take.';
  const requested = await trx.table('stock_transfer_request_lines').where({ stock_item_id: stockItemId }).first('id');
  if (requested) return 'It is on a stock request.';

  const components = await trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).select('stock_item_id', 'quantity');
  const sameRecipe = components.length === 1 && String(components[0].stock_item_id) === String(stockItemId) && compareQuantity(components[0].quantity, RECIPE_QUANTITY) === 0;
  if (!sameRecipe) return 'Its recipe has changed since the import.';
  const usedElsewhere = await trx.table('pos_menu_item_components').where({ stock_item_id: stockItemId }).whereNot({ menu_item_id: menuItemId }).first('id');
  if (usedElsewhere) return 'Another product now uses its stock item.';

  const barcodes = (await trx.table('supermarket_barcodes').where({ menu_item_id: menuItemId }).select('barcode')).map((row) => keyOf(row.barcode));
  const expected = expectedBarcodes.map(keyOf);
  const sameBarcodes = barcodes.length === expected.length && expected.every((code) => barcodes.includes(code));
  if (!sameBarcodes) return 'Its barcodes have changed since the import.';
  return null;
}

async function removeProduct({ trx, run, menuItemId, stockItemId }) {
  await trx.table('supermarket_barcodes').where({ menu_item_id: menuItemId }).delete();
  await trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).delete();
  // The import's own receipt — the scoped ledger exception (file header).
  await trx.table('stock_movements').where({ stock_item_id: stockItemId, type: 'received', reference: importReference(run.id) }).delete();
  await trx.table('stock_levels').where({ stock_item_id: stockItemId }).delete();
  await trx.table('stock_items').where({ id: stockItemId }).delete();
  await trx.table('pos_outlet_menu_items').where({ menu_item_id: menuItemId }).delete();
  await trx.table('pos_menu_items').where({ id: menuItemId }).delete();
}

/** A menu category the import created, removed only once no menu item (any status) is filed under it. */
async function removeMenuCategoryIfUnused({ trx, categoryId }) {
  const category = await trx.table('pos_menu_categories').where({ id: categoryId }).forUpdate().first();
  if (!category) return { ok: true };
  const used = Number(await trx.table('pos_menu_items').where({ category: category.name }).count());
  if (used > 0) return { ok: false, reason: `The category "${category.name}" is still used by ${used} product(s).` };
  await trx.table('pos_outlet_categories').where({ category_id: category.id }).delete();
  await trx.table('pos_menu_categories').where({ id: category.id }).delete();
  return { ok: true };
}

/** A stock-list category the import registered, removed only once no stock item (any status) is filed under it. */
async function removeStockCategoryIfUnused({ trx, categoryId }) {
  const category = await trx.table('stock_item_categories').where({ id: categoryId }).forUpdate().first();
  if (!category) return { ok: true };
  const used = Number(await trx.table('stock_items').where({ category: category.name }).count());
  if (used > 0) return { ok: false, reason: `The stock category "${category.name}" is still used by ${used} stock item(s).` };
  await trx.table('stock_item_categories').where({ id: category.id }).delete();
  return { ok: true };
}
const CATEGORY_REMOVERS = { menu_category: removeMenuCategoryIfUnused, stock_category: removeStockCategoryIfUnused };

/**
 * Undo, per product, each in its own small transaction (a touched product
 * is refused and listed; untouched siblings are still removed). Then the
 * categories the import created, if now empty. Deletes the reversed rows'
 * imported_record_map entries; refused ones stay for a later attempt.
 */
async function rollbackProducts({ context, run }) {
  const db = runDb(context.tenantId, run);
  let expectedByRow = new Map();
  try {
    expectedByRow = new Map(readProductFile(run.file_path).map((row) => [row.__rowNumber, parseProductRow(row).product.barcodes]));
  } catch (error) {
    expectedByRow = null; // the stored file is gone or unreadable: barcodes cannot be compared, so refuse every product
  }

  const mapRows = await db.table('imported_record_map').where({ import_run_id: run.id, created: true });
  const byRow = new Map();
  for (const row of mapRows) {
    if (CATEGORY_REMOVERS[row.entity_type]) continue;
    if (!byRow.has(row.row_number)) byRow.set(row.row_number, {});
    byRow.get(row.row_number)[row.entity_type] = row;
  }

  let rowsRolledBack = 0;
  const rowsRefused = [];
  const imagesToDelete = [];

  for (const [rowNumber, pair] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const menuMap = pair.menu_item;
    const stockMap = pair.stock_item;
    let result;
    try {
      result = await db.transaction(async (trx) => {
        // Global lock order: stock_items before pos_menu_items (stock/service.js header).
        const stockItem = stockMap ? await trx.table('stock_items').where({ id: stockMap.entity_id }).forUpdate().first() : null;
        const menuItem = menuMap ? await trx.table('pos_menu_items').where({ id: menuMap.entity_id }).forUpdate().first() : null;
        if (!stockItem && !menuItem) return { ok: true };
        if (!stockItem || !menuItem) return { ok: false, name: menuItem?.name ?? stockItem?.name, reason: 'Only half of this product still exists; remove it by hand.' };
        if (!expectedByRow) return { ok: false, name: menuItem.name, reason: 'The uploaded file is no longer stored, so the barcodes cannot be checked.' };
        const reason = await refusalFor({ trx, run, menuItemId: menuItem.id, stockItemId: stockItem.id, expectedBarcodes: expectedByRow.get(rowNumber) ?? [] });
        if (reason) return { ok: false, name: menuItem.name, reason };
        await removeProduct({ trx, run, menuItemId: menuItem.id, stockItemId: stockItem.id });
        return { ok: true, image: menuItem.image_path };
      });
    } catch (error) {
      result = { ok: false, reason: `Could not be removed: ${error?.message || error}` };
    }
    if (result.ok) {
      rowsRolledBack += 1;
      if (result.image) imagesToDelete.push(result.image);
      await db.table('imported_record_map').whereIn('id', [menuMap?.id, stockMap?.id].filter(Boolean)).delete();
    } else {
      rowsRefused.push({ entityType: 'product', entityId: String(menuMap?.entity_id ?? stockMap?.entity_id), rowNumber, name: result.name ?? null, reason: result.reason });
    }
  }

  for (const row of mapRows.filter((r) => CATEGORY_REMOVERS[r.entity_type])) {
    let result;
    try {
      result = await db.transaction((trx) => CATEGORY_REMOVERS[row.entity_type]({ trx, categoryId: row.entity_id }));
    } catch (error) {
      result = { ok: false, reason: `Could not be removed: ${error?.message || error}` };
    }
    if (result.ok) {
      await db.table('imported_record_map').where({ id: row.id }).delete();
    } else {
      rowsRefused.push({ entityType: row.entity_type, entityId: String(row.entity_id), rowNumber: row.row_number, name: null, reason: result.reason });
    }
  }

  for (const image of imagesToDelete) menuImages.deleteImage(image);
  return { rowsRolledBack, rowsRefused };
}

module.exports = {
  keyOf,
  ENTITY_TYPE,
  COLUMNS,
  MAX_PRODUCT_ROWS,
  MENU_ITEM_REFERENCE_TABLES,
  STOCK_ITEM_REFERENCE_TABLES,
  templateCsv,
  readProductFile,
  parseProductRow,
  loadWorld,
  validateProducts,
  dryRunProducts,
  summarizeRun,
  commitProducts,
  rollbackProducts,
  importReference,
  replaceFindings,
  limitFindings,
};
