'use strict';

/**
 * Supermarket Stage 3: the product import's rules as a pure function —
 * `validateProducts` over parsed rows and a hand-built catalogue snapshot.
 * The same function runs in the dry run and again inside the commit.
 */

const { validateProducts, parseProductRow, limitFindings } = require('../../src/modules/supermarket/product-import');

function world(overrides = {}) {
  return {
    outlet: { id: 12, name: 'Mini Mart', type: 'supermarket', status: 'active' },
    businessDate: '2027-01-10',
    barcodes: new Map(),
    activeProducts: new Set(),
    categories: new Map(),
    stockCategories: new Map(),
    carriers: new Map(),
    stockItemNames: new Set(),
    ...overrides,
  };
}
let rowNumber = 0;
function row(values = {}) {
  rowNumber += 1;
  return { __rowNumber: rowNumber, name: `Item ${rowNumber}`, category: 'Mart Drinks', price: '100.00', barcodes: `B${rowNumber}`, cost_price: '60.00', opening_stock: '10', ...values };
}
const errorsOf = (result, n) => result.findings.filter((f) => f.severity === 'error' && (n === undefined || f.row_number === n));
const warningsOf = (result, n) => result.findings.filter((f) => f.severity === 'warning' && f.row_number === n);

describe('product import validation', () => {
  it('accepts a clean file and summarises what it will create', () => {
    const rows = [row({ barcodes: '111|222' }), row({ category: 'mart drinks', opening_stock: '2.5', cost_price: '1.00' }), row({ category: 'Mart Snacks', opening_stock: '' })];
    const result = validateProducts({ rows, world: world() });
    expect(errorsOf(result)).toEqual([]);
    expect(result.summary).toMatchObject({ products: 3, categoriesToCreate: 2, barcodes: 4, productsWithOpeningStock: 2, openingStockUnits: '12.500', errors: 0 });
    // The first spelling in the file is the one created.
    expect(result.products[1].category).toBe('Mart Drinks');
    expect(result.products.every((p) => p.categoryIsNew)).toBe(true);
  });

  it.each([
    ['name', { name: '' }],
    ['name', { name: 'x'.repeat(151) }],
    ['category', { category: '' }],
    ['category', { category: 'c'.repeat(61) }],
    ['price', { price: '' }],
    ['price', { price: '12.345' }],
    ['price', { price: '-1' }],
    ['barcodes', { barcodes: 'has space' }],
    ['barcodes', { barcodes: `${'9'.repeat(65)}` }],
    ['barcodes', { barcodes: '123|123' }],
    ['unit', { unit: 'u'.repeat(31) }],
    ['cost_price', { cost_price: 'abc' }],
    ['opening_stock', { opening_stock: '1.2345' }],
    ['opening_stock', { opening_stock: '-3' }],
    ['reorder_level', { reorder_level: 'lots' }],
    ['supplier', { supplier: 's'.repeat(151) }],
  ])('refuses a bad %s (%j)', (column, values) => {
    const r = row(values);
    const result = validateProducts({ rows: [r], world: world() });
    expect(errorsOf(result, r.__rowNumber).map((f) => f.column_name)).toContain(column);
  });

  it('requires a cost price when there is opening stock, and only then', () => {
    const withStock = row({ cost_price: '', opening_stock: '5' });
    const without = row({ cost_price: '', opening_stock: '' });
    const zero = row({ cost_price: '', opening_stock: '0' });
    const result = validateProducts({ rows: [withStock, without, zero], world: world() });
    expect(errorsOf(result, withStock.__rowNumber)).toEqual([expect.objectContaining({ column_name: 'cost_price' })]);
    expect(errorsOf(result, without.__rowNumber)).toEqual([]);
    expect(errorsOf(result, zero.__rowNumber)).toEqual([]);
  });

  it.each(['0', '0.00'])('refuses a zero cost price (%s) when there is opening stock', (cost) => {
    const r = row({ cost_price: cost, opening_stock: '5' });
    const result = validateProducts({ rows: [r], world: world() });
    expect(errorsOf(result, r.__rowNumber)).toEqual([expect.objectContaining({ column_name: 'cost_price' })]);
    const noStock = row({ cost_price: '0.00', opening_stock: '' });
    expect(errorsOf(validateProducts({ rows: [noStock], world: world() }))).toEqual([]);
  });

  it('refuses a barcode Excel turned into scientific notation', () => {
    const r = row({ barcodes: '5.449E+12|5449000000996' });
    const result = validateProducts({ rows: [r], world: world() });
    expect(errorsOf(result, r.__rowNumber)[0].message).toContain('scientific notation');
    expect(result.products[0].barcodes).toEqual(['5449000000996']);
  });

  it('caps the findings a response carries, keeping the full counts', () => {
    const findings = [
      ...Array.from({ length: 350 }, (_, i) => ({ row_number: i, severity: 'warning' })),
      ...Array.from({ length: 5 }, (_, i) => ({ row_number: i, severity: 'error' })),
    ];
    const { errors, findingCounts } = limitFindings(findings);
    expect(findingCounts).toEqual({ errors: 5, warnings: 350, shownPerKind: 300 });
    expect(errors.filter((f) => f.severity === 'warning')).toHaveLength(300);
    expect(errors.filter((f) => f.severity === 'error')).toHaveLength(5);
  });

  it('matches names ignoring accents like the database does, but not other symbols', () => {
    const a = row({ name: 'Café Latte', category: 'Mart Hot' });
    const b = row({ name: 'Cafe Latte', category: 'mart hot' });
    const c = row({ name: 'A^B', category: 'Mart Hot' });
    const d = row({ name: 'AB', category: 'Mart Hot' });
    const result = validateProducts({ rows: [a, b, c, d], world: world() });
    expect(errorsOf(result, a.__rowNumber)).toHaveLength(1);
    expect(errorsOf(result, c.__rowNumber)).toEqual([]);
  });

  it('flags every row sharing a barcode, naming the others, case-insensitively', () => {
    const a = row({ barcodes: 'abc1' });
    const b = row({ barcodes: 'X|ABC1' });
    const c = row({ barcodes: 'abc1' });
    const result = validateProducts({ rows: [a, b, c], world: world() });
    expect(errorsOf(result, a.__rowNumber)[0].message).toContain(`row(s) ${b.__rowNumber}, ${c.__rowNumber}`);
    expect(errorsOf(result, b.__rowNumber)).toHaveLength(1);
    expect(errorsOf(result, c.__rowNumber)).toHaveLength(1);
  });

  it('refuses a barcode already registered, naming the product', () => {
    const r = row({ barcodes: '5449' });
    const result = validateProducts({ rows: [r], world: world({ barcodes: new Map([['5449', { barcode: '5449', name: 'Fanta', category: 'Bar Drinks' }]]) }) });
    expect(errorsOf(result, r.__rowNumber)[0].message).toBe('The barcode "5449" already belongs to "Fanta" (Bar Drinks).');
  });

  it('refuses a name+category twice in the file, and one that already exists (create-only)', () => {
    const a = row({ name: 'Milo 400g', category: 'Mart Food' });
    const b = row({ name: 'milo 400G ', category: 'mart food' });
    const c = row({ name: 'Peak Milk', category: 'Mart Food' });
    const result = validateProducts({ rows: [a, b, c], world: world({ activeProducts: new Set(['peak milk::mart food']) }) });
    expect(errorsOf(result, a.__rowNumber).map((f) => f.column_name)).toEqual(['name']);
    expect(errorsOf(result, b.__rowNumber).map((f) => f.column_name)).toEqual(['name']);
    expect(errorsOf(result, c.__rowNumber)[0].message).toContain('only creates new products');
  });

  it('blocks a category carried by an active selling outlet, but not by an archived one, another mart or a store room', () => {
    const categories = new Map([
      ['drinks', { id: 1, name: 'Drinks', status: 'active' }],
      ['old', { id: 2, name: 'Old', status: 'active' }],
      ['mart', { id: 3, name: 'Mart', status: 'active' }],
    ]);
    const carriers = new Map([
      ['1', [{ outlet_name: 'Bar', type: 'bar', status: 'active' }, { outlet_name: 'Restaurant', type: 'restaurant', status: 'active' }]],
      ['2', [{ outlet_name: 'Closed Bar', type: 'bar', status: 'archived' }]],
      ['3', [{ outlet_name: 'Other Mart', type: 'supermarket', status: 'active' }, { outlet_name: 'Store-1', type: 'store', status: 'active' }]],
    ]);
    const drinks = row({ category: 'drinks' });
    const old = row({ category: 'Old' });
    const mart = row({ category: 'Mart' });
    const result = validateProducts({ rows: [drinks, old, mart], world: world({ categories, carriers }) });
    expect(errorsOf(result, drinks.__rowNumber)[0].message).toBe('"Drinks" is sold at Bar, Restaurant — use a supermarket category name such as "Mart Drinks".');
    expect(errorsOf(result, old.__rowNumber)).toEqual([]);
    expect(errorsOf(result, mart.__rowNumber)).toEqual([]);
    expect(result.products[0]).toMatchObject({ category: 'Drinks', categoryIsNew: false });
  });

  it('refuses an archived category and an archived stock twin', () => {
    const archived = row({ category: 'Gone' });
    const stockArchived = row({ category: 'Half' });
    const result = validateProducts({
      rows: [archived, stockArchived],
      world: world({
        categories: new Map([['gone', { id: 9, name: 'Gone', status: 'archived' }]]),
        stockCategories: new Map([['half', { name: 'Half', status: 'archived' }]]),
      }),
    });
    expect(errorsOf(result, archived.__rowNumber)[0].message).toContain('archived');
    expect(errorsOf(result, stockArchived.__rowNumber)[0].message).toContain('stock category "Half" is archived');
  });

  it('warns (never blocks) on no barcode, no opening stock and an existing stock item name', () => {
    const r = row({ name: 'Sugar 1kg', barcodes: '', opening_stock: '', cost_price: '' });
    const result = validateProducts({ rows: [r], world: world({ stockItemNames: new Set(['sugar 1kg']) }) });
    expect(errorsOf(result)).toEqual([]);
    expect(warningsOf(result, r.__rowNumber).map((f) => f.column_name).sort()).toEqual(['barcodes', 'name', 'opening_stock']);
  });

  it('refuses opening stock when the property has no business date, and every row when the outlet is no longer a supermarket', () => {
    const r = row();
    expect(errorsOf(validateProducts({ rows: [r], world: world({ businessDate: null }) }), r.__rowNumber)[0].column_name).toBe('opening_stock');
    const bar = validateProducts({ rows: [row()], world: world({ outlet: { id: 1, type: 'bar', status: 'active' } }) });
    expect(errorsOf(bar)[0].message).toContain('no longer an active supermarket');
  });

  it('normalises values', () => {
    const { product, problems } = parseProductRow({ __rowNumber: 1, name: ' Rice ', category: 'Mart Food', price: '5', barcodes: ' 001 | 002 |', unit: '', opening_stock: '3', cost_price: '2', reorder_level: '1' });
    expect(problems).toEqual([]);
    expect(product).toMatchObject({ name: 'Rice', barcodes: ['001', '002'], unit: 'pcs', openingStock: '3.000', reorderLevel: '1.000', costPrice: '2' });
  });
});
