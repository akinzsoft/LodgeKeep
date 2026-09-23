import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../../shared/api/index.js';
import { photoProblem, choiceFromSelection, classifyStockItem, defaultCategorySelection, CREATE_CATEGORY_VALUE, menuCategoryChoiceFor, sellStockItemInRegister, validateSellFields } from '../sellInRegister.js';

const mocks = vi.hoisted(() => ({
  createMenuCategory: vi.fn(),
  createMenuItem: vi.fn(),
  upsertMenuItemComponents: vi.fn(),
  uploadMenuItemImage: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    posApi: { createMenuCategory: mocks.createMenuCategory, createMenuItem: mocks.createMenuItem, uploadMenuItemImage: mocks.uploadMenuItemImage },
    stockApi: { upsertMenuItemComponents: mocks.upsertMenuItemComponents },
  };
});

describe('menuCategoryChoiceFor / defaultCategorySelection / choiceFromSelection', () => {
  const categories = [{ id: '1', name: 'Beverages' }];

  it('matches a registered category case-insensitively, keeping its own spelling', () => {
    expect(menuCategoryChoiceFor('  beverages ', categories)).toEqual({ mode: 'existing', name: 'Beverages' });
    expect(defaultCategorySelection('BEVERAGES', categories)).toBe('Beverages');
  });

  it('offers to create one named after the stock category when none matches', () => {
    expect(menuCategoryChoiceFor('Spirits', categories)).toEqual({ mode: 'create', name: 'Spirits' });
    expect(defaultCategorySelection('Spirits', categories)).toBe(CREATE_CATEGORY_VALUE);
    expect(menuCategoryChoiceFor('Spirits', null)).toEqual({ mode: 'create', name: 'Spirits' });
  });

  it('never invents a category for an uncategorized item', () => {
    expect(menuCategoryChoiceFor(null, categories)).toEqual({ mode: 'choose' });
    expect(menuCategoryChoiceFor('   ', categories)).toEqual({ mode: 'choose' });
    expect(defaultCategorySelection(null, categories)).toBe('');
  });

  it('turns a select value back into a choice', () => {
    expect(choiceFromSelection(CREATE_CATEGORY_VALUE, ' Spirits ')).toEqual({ mode: 'create', name: 'Spirits' });
    expect(choiceFromSelection('Beverages', 'x')).toEqual({ mode: 'existing', name: 'Beverages' });
    expect(choiceFromSelection('', 'x')).toEqual({ mode: 'choose' });
  });
});

describe('classifyStockItem', () => {
  const links = [
    { menu_item_id: '1', menu_item_name: 'Vodka shot', stock_item_id: '9', component_count: 1 },
    { menu_item_id: '2', menu_item_name: 'Cocktail', stock_item_id: '9', component_count: 3 },
    { menu_item_id: '2', menu_item_name: 'Cocktail', stock_item_id: '10', component_count: 3 },
  ];

  it('is "direct" when some menu item is made of just that one stock item — even if it is also used in other recipes', () => {
    expect(classifyStockItem('9', links)).toMatchObject({ kind: 'direct', menuItemName: 'Vodka shot', menuItemCount: 2 });
  });

  it('is "ingredient" when it only appears inside multi-component recipes', () => {
    expect(classifyStockItem('10', links)).toMatchObject({ kind: 'ingredient', menuItemCount: 1 });
  });

  it('is "none" when no menu item uses it, and compares ids as strings', () => {
    expect(classifyStockItem('99', links).kind).toBe('none');
    expect(classifyStockItem(9, links).kind).toBe('direct');
    expect(classifyStockItem('9', null).kind).toBe('none');
  });
});

describe('validateSellFields', () => {
  const ok = { name: 'Gin', price: '12.50', quantityPerSale: '1', categoryChoice: { mode: 'existing', name: 'Beverages' } };

  it('accepts valid fields, including a zero price and a fractional quantity', () => {
    expect(validateSellFields(ok)).toBeNull();
    expect(validateSellFields({ ...ok, price: '0' })).toBeNull();
    expect(validateSellFields({ ...ok, quantityPerSale: '0.5' })).toBeNull();
  });

  it('checks the optional photo\'s type and size', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    expect(validateSellFields({ ...ok, photo: png })).toBeNull();
    expect(validateSellFields({ ...ok, photo: null })).toBeNull();
    expect(photoProblem(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/JPG, PNG, or WebP/);
    const big = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 + 1 });
    expect(photoProblem(big)).toMatch(/2 MB/);
    expect(validateSellFields({ ...ok, photo: big })).toMatch(/2 MB/);
  });

  it('rejects each bad field with its own message', () => {
    expect(validateSellFields({ ...ok, name: '  ' })).toMatch(/name/);
    expect(validateSellFields({ ...ok, categoryChoice: { mode: 'choose' } })).toMatch(/category/);
    expect(validateSellFields({ ...ok, price: '' })).toMatch(/price/);
    expect(validateSellFields({ ...ok, price: '1.999' })).toMatch(/2 decimal/);
    expect(validateSellFields({ ...ok, price: '-1' })).toMatch(/price/);
    expect(validateSellFields({ ...ok, quantityPerSale: '0' })).toMatch(/more than zero/);
    expect(validateSellFields({ ...ok, quantityPerSale: '1.2345' })).toMatch(/3 decimal/);
  });
});

describe('sellStockItemInRegister', () => {
  const stockItem = { id: '9', outlet_id: '1' };
  const base = { stockItem, name: ' Gin ', price: ' 12 ', quantityPerSale: ' 1 ', categoryChoice: { mode: 'existing', name: 'Beverages' } };

  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('creates the menu item on the stock item\'s own outlet, then links it — trimming every field', async () => {
    mocks.createMenuItem.mockResolvedValue({ id: '60' });
    mocks.upsertMenuItemComponents.mockResolvedValue([]);
    const result = await sellStockItemInRegister(base);

    expect(result).toEqual({ ok: true, menuItem: { id: '60' }, photoError: null });
    expect(mocks.createMenuCategory).not.toHaveBeenCalled();
    expect(mocks.createMenuItem).toHaveBeenCalledWith({ outletId: '1', name: 'Gin', category: 'Beverages', price: '12' });
    expect(mocks.upsertMenuItemComponents).toHaveBeenCalledWith('60', [{ stockItemId: '9', quantity: '1' }]);
    expect(mocks.createMenuItem.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsertMenuItemComponents.mock.invocationCallOrder[0]);
  });

  it('creates the category first when asked, and tolerates it already existing (409)', async () => {
    mocks.createMenuCategory.mockRejectedValue(new ApiError({ code: 'CONFLICT', message: 'exists', status: 409 }));
    mocks.createMenuItem.mockResolvedValue({ id: '61' });
    mocks.upsertMenuItemComponents.mockResolvedValue([]);
    const result = await sellStockItemInRegister({ ...base, categoryChoice: { mode: 'create', name: 'Spirits' } });

    expect(result.ok).toBe(true);
    expect(mocks.createMenuCategory).toHaveBeenCalledWith({ name: 'Spirits' });
    expect(mocks.createMenuItem).toHaveBeenCalledWith(expect.objectContaining({ category: 'Spirits' }));
  });

  it('stops at a category failure that is not a duplicate, creating nothing else', async () => {
    mocks.createMenuCategory.mockRejectedValue(new ApiError({ code: 'FORBIDDEN_PERMISSION', message: 'No.', status: 403 }));
    const result = await sellStockItemInRegister({ ...base, categoryChoice: { mode: 'create', name: 'Spirits' } });

    expect(result).toMatchObject({ ok: false, step: 'category', message: 'No.', resume: { menuItemId: null } });
    expect(mocks.createMenuItem).not.toHaveBeenCalled();
  });

  it('stops at a menu-item failure without linking anything', async () => {
    mocks.createMenuItem.mockRejectedValue(new ApiError({ code: 'VALIDATION', message: 'Bad.', status: 400 }));
    const result = await sellStockItemInRegister(base);

    expect(result).toMatchObject({ ok: false, step: 'menuItem', message: 'Bad.', resume: { menuItemId: null } });
    expect(mocks.upsertMenuItemComponents).not.toHaveBeenCalled();
  });

  it('after a link failure, reports the created menu item, and a resume redoes only the link — the menu item is created exactly once across both attempts', async () => {
    mocks.createMenuItem.mockResolvedValue({ id: '62' });
    mocks.upsertMenuItemComponents.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL', message: 'Link broke.', status: 500 })).mockResolvedValueOnce([]);

    const first = await sellStockItemInRegister({ ...base, categoryChoice: { mode: 'create', name: 'Spirits' } });
    expect(first).toMatchObject({ ok: false, step: 'link', resume: { menuItemId: '62' } });

    const second = await sellStockItemInRegister({ ...base, categoryChoice: { mode: 'create', name: 'Spirits' }, resume: first.resume });
    expect(second.ok).toBe(true);
    expect(mocks.createMenuItem).toHaveBeenCalledTimes(1);
    expect(mocks.createMenuCategory).toHaveBeenCalledTimes(1);
    expect(mocks.upsertMenuItemComponents).toHaveBeenLastCalledWith('62', [{ stockItemId: '9', quantity: '1' }]);
  });
  it('remembers the quantity per sale across a resume, so a retry from a blank form still links the amount originally entered', async () => {
    mocks.createMenuItem.mockResolvedValue({ id: '64' });
    mocks.upsertMenuItemComponents.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL', message: 'Link broke.', status: 500 })).mockResolvedValueOnce([]);

    const first = await sellStockItemInRegister({ ...base, quantityPerSale: ' 50 ' });
    expect(first.resume).toEqual({ menuItemId: '64', quantityPerSale: '50' });

    const second = await sellStockItemInRegister({ stockItem, name: '', price: '', quantityPerSale: '', categoryChoice: { mode: 'choose' }, resume: first.resume });
    expect(second.ok).toBe(true);
    expect(mocks.upsertMenuItemComponents).toHaveBeenLastCalledWith('64', [{ stockItemId: '9', quantity: '50' }]);
    expect(mocks.createMenuItem).toHaveBeenCalledTimes(1);
  });
  describe('item photo', () => {
    const photo = new File(['x'], 'lager.png', { type: 'image/png' });

    it('uploads the photo to the new menu item before linking the stock', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '65' });
      mocks.upsertMenuItemComponents.mockResolvedValue([]);
      const result = await sellStockItemInRegister({ ...base, photo });

      expect(result).toMatchObject({ ok: true, photoError: null });
      expect(mocks.uploadMenuItemImage).toHaveBeenCalledWith('65', photo);
      expect(mocks.createMenuItem.mock.invocationCallOrder[0]).toBeLessThan(mocks.uploadMenuItemImage.mock.invocationCallOrder[0]);
    });

    it('does not touch the upload endpoint when no photo was chosen', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '66' });
      mocks.upsertMenuItemComponents.mockResolvedValue([]);
      await sellStockItemInRegister(base);
      expect(mocks.uploadMenuItemImage).not.toHaveBeenCalled();
    });

    it('a failed upload never fails the setup — the item is still linked and sellable — and is reported as photoError', async () => {
      mocks.createMenuItem.mockResolvedValue({ id: '67' });
      mocks.uploadMenuItemImage.mockRejectedValue(new ApiError({ code: 'VALIDATION', message: 'Not an image.', status: 400 }));
      mocks.upsertMenuItemComponents.mockResolvedValue([]);
      const result = await sellStockItemInRegister({ ...base, photo });

      expect(result).toMatchObject({ ok: true, photoError: 'Not an image.' });
      expect(mocks.upsertMenuItemComponents).toHaveBeenCalledWith('67', [{ stockItemId: '9', quantity: '1' }]);
    });

    it('a link retry (resume) never uploads the photo a second time', async () => {
      mocks.upsertMenuItemComponents.mockResolvedValue([]);
      await sellStockItemInRegister({ ...base, photo, resume: { menuItemId: '68', quantityPerSale: '1' } });
      expect(mocks.uploadMenuItemImage).not.toHaveBeenCalled();
      expect(mocks.createMenuItem).not.toHaveBeenCalled();
    });
  });
});
