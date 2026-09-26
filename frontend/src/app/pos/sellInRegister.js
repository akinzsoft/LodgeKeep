import { posApi, stockApi, ApiError } from '../../shared/api/index.js';

/**
 * "Sell in Register" — the missing bridge between the Stock items screen and
 * the POS Register (user-reported: categories and items created under
 * Stock → Stock items never showed up in the Register to sell).
 *
 * Why the gap existed: a stock item is an inventory record (`stock_items`,
 * with its own `stock_item_categories`), while the Register only ever sells
 * `pos_menu_items` (with `pos_menu_categories`). The ONLY link between the
 * two is a recipe line (`pos_menu_item_components`) on a menu item. Nothing
 * on the Stock screen ever created that menu item, so a stock item could
 * never be sold. Selling is deliberately an explicit choice — stock items
 * include ingredients (a bottle of gin used in cocktails, a syrup measured
 * in ml), and auto-listing every one of them would bury the real menu.
 *
 * The two category systems are separate tables joined by name string only,
 * so a stock category "Beer" does not imply a menu category "Beer". This
 * module derives the menu category from the stock category's name and
 * creates it on first use.
 *
 * The three writes span two backend modules and three RBAC keys, so this
 * is deliberately frontend orchestration, not one atomic endpoint. The
 * order is category → menu item → recipe link; once the menu item exists
 * the item is already sellable, so a failure at the recipe step reports
 * `resume: { menuItemId }` and a retry only redoes the link, never creating
 * the menu item twice.
 */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * A client-side pre-check so an oversized or wrong-type photo fails fast —
 * the server checks the real bytes regardless. Same limits as the Menu
 * items screen's own item image (`MenuItemsTab.jsx`), kept as a small
 * duplicate rather than reaching into that screen's module.
 */
export function photoProblem(file) {
  if (!file) return null;
  if (!PHOTO_TYPES.includes(file.type)) return 'The photo must be a JPG, PNG, or WebP image.';
  if (file.size > MAX_PHOTO_BYTES) return 'The photo must be 2 MB or smaller.';
  return null;
}

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;

/** Case-insensitive, trimmed comparison key for a category name. */
function nameKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Which menu category a stock item should be sold under: the registered
 * menu category matching the stock category's name (any case — the backend
 * resolves case-insensitively and stores its own canonical spelling), else
 * a category to create with that name, else nothing (an uncategorized stock
 * item — the user must pick, nothing is invented).
 *
 * @returns {{mode: 'existing', name: string} | {mode: 'create', name: string} | {mode: 'choose'}}
 */
export function menuCategoryChoiceFor(stockCategory, menuCategories) {
  const wanted = String(stockCategory ?? '').trim();
  if (!wanted) return { mode: 'choose' };
  const match = (menuCategories ?? []).find((category) => nameKey(category.name) === nameKey(wanted));
  if (match) return { mode: 'existing', name: match.name };
  return { mode: 'create', name: wanted };
}

/** The select's sentinel value for "create a Register category named after the stock category". */
export const CREATE_CATEGORY_VALUE = '__create__';

/** The category select's starting value for a stock item — see `menuCategoryChoiceFor`. `''` means the user must pick. */
export function defaultCategorySelection(stockCategory, menuCategories) {
  const choice = menuCategoryChoiceFor(stockCategory, menuCategories);
  if (choice.mode === 'existing') return choice.name;
  if (choice.mode === 'create') return CREATE_CATEGORY_VALUE;
  return '';
}

/** Turns the select's current value back into the choice `sellStockItemInRegister` expects. */
export function choiceFromSelection(selection, stockCategory) {
  if (selection === CREATE_CATEGORY_VALUE) return { mode: 'create', name: String(stockCategory ?? '').trim() };
  if (selection) return { mode: 'existing', name: selection };
  return { mode: 'choose' };
}

/**
 * How one stock item relates to the Register, from the flattened recipe
 * links (`stockApi.listMenuItemLinks`):
 *  - `direct`     — some menu item's ENTIRE recipe is this one stock item
 *                   (a bottle sold as a bottle);
 *  - `ingredient` — used only inside multi-component recipes (cocktails);
 *  - `none`       — not part of any Register menu item.
 */
export function classifyStockItem(stockItemId, links) {
  const mine = (links ?? []).filter((link) => String(link.stock_item_id) === String(stockItemId));
  const direct = mine.find((link) => link.component_count === 1);
  if (direct) return { kind: 'direct', menuItemName: direct.menu_item_name, menuItemId: direct.menu_item_id, menuItemCount: mine.length };
  if (mine.length > 0) return { kind: 'ingredient', menuItemName: null, menuItemId: null, menuItemCount: mine.length };
  return { kind: 'none', menuItemName: null, menuItemId: null, menuItemCount: 0 };
}

/** Returns a message for the first invalid field, or `null` when all are fine. Money/quantity stay strings — never parsed to floats. */
export function validateSellFields({ name, price, quantityPerSale, categoryChoice, photo }) {
  if (!String(name ?? '').trim()) return 'Enter the name to show in the Register.';
  if (!categoryChoice || categoryChoice.mode === 'choose') return 'Choose the menu category this item is sold under.';
  if (!MONEY_PATTERN.test(String(price ?? '').trim())) return 'Enter a selling price of zero or more, with at most 2 decimal places.';
  const quantity = String(quantityPerSale ?? '').trim();
  if (!QUANTITY_PATTERN.test(quantity) || Number(quantity) <= 0) return 'Enter how much of this stock item one sale uses — more than zero, with at most 3 decimal places.';
  return photoProblem(photo);
}

/**
 * Creates the Register menu item for a stock item and links its recipe.
 *
 * @param {object} args
 * @param {object} args.stockItem   the stock item (needs `id`, `outlet_id`)
 * @param {string} args.name        menu item name
 * @param {string} args.price       selling price, decimal string
 * @param {{mode: string, name?: string}} args.categoryChoice  see `menuCategoryChoiceFor`; `'existing'`/`'create'` carry the menu category name
 * @param {string} args.quantityPerSale  stock-item units consumed per one sale
 * @param {File|null} [args.photo]  optional item image, uploaded right after the menu item is created. A failed upload never fails the sale setup — the item is already sellable — it is reported as `photoError` on the result instead.
 * @param {{menuItemId?: string|number, quantityPerSale?: string}} [args.resume]  set after a partial failure so the menu item is not created twice
 * @returns {Promise<{ok: true, menuItem: object} | {ok: false, step: 'category'|'menuItem'|'link', message: string, resume: {menuItemId: (string|number)|null}}>}
 */
export async function sellStockItemInRegister({ stockItem, name, price, categoryChoice, quantityPerSale, photo, resume }) {
  let menuItemId = resume?.menuItemId ?? null;
  let menuItem = null;
  let photoError = null;
  // A resume remembers the quantity the user originally entered, so a retry from a reopened (blank) form still links the right amount.
  const quantity = (resume?.quantityPerSale ?? quantityPerSale ?? '').trim();

  if (menuItemId === null) {
    if (categoryChoice.mode === 'create') {
      try {
        await posApi.createMenuCategory({ name: categoryChoice.name });
      } catch (caught) {
        // Already there (a concurrent create, or the list was stale) — the
        // category we wanted exists, which is all this step needs.
        if (!(caught instanceof ApiError && caught.status === 409)) {
          return { ok: false, step: 'category', message: messageOf(caught, 'Could not create the menu category.'), resume: { menuItemId: null } };
        }
      }
    }

    try {
      menuItem = await posApi.createMenuItem({ outletId: stockItem.outlet_id, name: name.trim(), category: categoryChoice.name, price: price.trim() });
      menuItemId = menuItem.id;
    } catch (caught) {
      return { ok: false, step: 'menuItem', message: messageOf(caught, 'Could not add this item to the Register.'), resume: { menuItemId: null } };
    }

    // Once, right after creation — a resume (link retry) never re-uploads.
    if (photo) {
      try {
        await posApi.uploadMenuItemImage(menuItemId, photo);
      } catch (caught) {
        photoError = messageOf(caught, 'The photo could not be uploaded.');
      }
    }
  }

  try {
    await stockApi.upsertMenuItemComponents(menuItemId, [{ stockItemId: stockItem.id, quantity }]);
  } catch (caught) {
    return { ok: false, step: 'link', message: messageOf(caught, 'Could not link the stock item.'), resume: { menuItemId, quantityPerSale: quantity }, photoError };
  }

  return { ok: true, menuItem: menuItem ?? { id: menuItemId }, photoError };
}

function messageOf(caught, fallback) {
  return caught instanceof ApiError ? caught.message : fallback;
}
