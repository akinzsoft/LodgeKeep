import { CREATE_CATEGORY_VALUE, menuCategoryChoiceFor } from './sellInRegister.js';
import formStyles from './POSForm.module.css';

/**
 * The four fields a stock item needs to be sold in the POS Register —
 * shared by the Stock items screen's "Sell in Register" panel and its
 * "Also sell in Register" checkbox on the Add form (see
 * `sellInRegister.js` for why this bridge exists at all).
 *
 * Fully controlled: the parent owns `values` (`{name, price, category,
 * quantity}`) and the orchestration. Every field gets an explicit
 * `id`/`htmlFor` with its hint kept OUTSIDE the `<label>`, so the
 * accessible name stays just the field's name — the wrapping-label bug this
 * codebase has already fixed more than once.
 *
 * `menuCategories` is the registered Register (menu) category list, or
 * `null` while it loads.
 */
export function SellInRegisterFields({ idPrefix, values, onChange, menuCategories, stockCategory, unit, onHand, duplicateName, isOffline, showPhoto = true }) {
  const set = (field) => (event) => onChange({ ...values, [field]: event.target.value });
  // Only offered when no registered Register category already matches the stock category's name.
  const createLabel = stockCategory && menuCategoryChoiceFor(stockCategory, menuCategories).mode === 'create' ? `Create "${String(stockCategory).trim()}"` : null;
  const hasCategoryChoice = values.category === CREATE_CATEGORY_VALUE || (menuCategories ?? []).some((category) => category.name === values.category);
  const showZeroStockHint = onHand !== undefined && onHand !== null && Number(onHand) <= 0;

  return (
    <>
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor={`${idPrefix}-name`}>
          Name in Register
        </label>
        <input id={`${idPrefix}-name`} className={formStyles.input} value={values.name} onChange={set('name')} required disabled={isOffline} />
        {duplicateName && <p className={formStyles.hint}>A Register item named &quot;{values.name.trim()}&quot; already exists at this outlet. You can still continue.</p>}
      </div>

      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor={`${idPrefix}-price`}>
          Selling price
        </label>
        <input id={`${idPrefix}-price`} className={formStyles.input} type="number" step="0.01" min="0" value={values.price} onChange={set('price')} required disabled={isOffline} />
      </div>

      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor={`${idPrefix}-category`}>
          Menu category
        </label>
        <select id={`${idPrefix}-category`} className={formStyles.select} value={values.category} onChange={set('category')} required disabled={isOffline || menuCategories === null}>
          <option value="" disabled>
            {menuCategories === null ? 'Loading menu categories…' : 'Select a menu category'}
          </option>
          {createLabel && <option value={CREATE_CATEGORY_VALUE}>{createLabel}</option>}
          {(menuCategories ?? []).map((category) => (
            <option key={category.id} value={category.name}>
              {category.name}
            </option>
          ))}
          {!hasCategoryChoice && values.category !== '' && <option value={values.category}>{values.category}</option>}
        </select>
      </div>

      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor={`${idPrefix}-quantity`}>
          {`Used per sale (${unit || 'units'})`}
        </label>
        <input
          id={`${idPrefix}-quantity`}
          className={formStyles.input}
          type="number"
          step="0.001"
          min="0"
          value={values.quantity}
          onChange={set('quantity')}
          required
          disabled={isOffline}
        />
        <p className={formStyles.hint}>
          How much of this stock item one sale uses up — 1 for something sold whole (a bottle or can), or the measured amount (for example 50 for a 50 ml serve of an item counted in ml).
        </p>
      </div>
      {showPhoto && (
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor={`${idPrefix}-photo`}>
            Item image (optional)
          </label>
          <input
            id={`${idPrefix}-photo`}
            className={formStyles.fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => onChange({ ...values, photo: event.target.files?.[0] ?? null })}
            disabled={isOffline}
          />
          <p className={formStyles.hint}>Shown on the item&apos;s tile in the Register. JPG, PNG or WebP, up to 2 MB.</p>
        </div>
      )}
      {showZeroStockHint && <p className={formStyles.hint}>None on hand yet — receive stock first, or the Register will ask for a low-stock override when this is sold.</p>}
    </>
  );
}
