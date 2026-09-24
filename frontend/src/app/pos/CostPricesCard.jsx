import { useMemo, useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Pads a valid amount to two decimals ("12" -> "12.00") so an unchanged value typed without them isn't seen as an edit. Anything else is returned trimmed. */
function normalizeAmount(value) {
  const typed = String(value).trim();
  if (!MONEY_PATTERN.test(typed)) return typed;
  const [whole, fraction = ''] = typed.split('.');
  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
}

/** The value an input shows for a stored cost price (`null` = not set). */
function storedValue(item) {
  return item.cost_price === null || item.cost_price === undefined ? '' : String(item.cost_price);
}

/**
 * CostPricesCard — set every menu item's cost price in one place, so the
 * Sales and margin reports can show profit (an item with no cost is
 * "Unknown" there and left out of profit).
 *
 * A menu item's cost comes from its stock recipe when it has one, and only
 * otherwise from this cost price — the recipe always wins
 * (`stock/reporting.js`). So items that have a stock recipe are shown
 * read-only here ("from stock"), and only items with no recipe get an
 * input: typing a cost price on an item whose recipe overrides it would
 * silently do nothing. An item sold from stock whose stock cost is still
 * zero (nothing received yet) is flagged, because its profit would look
 * like a full 100% margin.
 *
 * Saving is one `PATCH /pos/menu-items/:id` per CHANGED row, run one at a
 * time — there is no bulk endpoint, and each row's own validation error
 * should name the row it belongs to. A failure never stops the rest: every
 * row that saved stays saved, and the ones that didn't are listed and stay
 * in the table with their typed value, so they can be corrected and saved
 * again. Cost is entered as an exact decimal string (at most 2 decimals) —
 * never parsed to a float.
 *
 * `menuItems` are the outlet's active menu items; `linkedStockItemFor(id)`
 * gives a single-component item's stock item (or null); `recipeKind(id)` is
 * `'none' | 'stock' | 'compound'`. `onSaved` reloads the parent's items.
 */
export function CostPricesCard({ menuItems, recipeKind, linkedStockItemFor, activeProperty, isOffline = false, onSaved }) {
  const currencyCode = activeProperty.base_currency;
  // `{[menuItemId]: typed string}` — only rows the user has touched.
  const [drafts, setDrafts] = useState({});
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [failures, setFailures] = useState([]);

  const rows = useMemo(
    () => (menuItems ?? []).slice().sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name)),
    [menuItems]
  );

  const valueFor = (item) => (drafts[item.id] !== undefined ? drafts[item.id] : storedValue(item));
  const isDirty = (item) => drafts[item.id] !== undefined && normalizeAmount(drafts[item.id]) !== normalizeAmount(storedValue(item));
  const editable = (item) => recipeKind(item.id) === 'none';

  const dirtyItems = rows.filter((item) => editable(item) && isDirty(item));
  const editableRows = rows.filter(editable);
  const missingCount = editableRows.filter((item) => storedValue(item) === '').length;
  // A row with an unsaved edit stays visible under the filter, so a queued change never hides from the user.
  const visibleRows = onlyMissing ? rows.filter((item) => editable(item) && (storedValue(item) === '' || isDirty(item))) : rows;

  function setDraft(item, value) {
    setMessage(null);
    setDrafts((current) => ({ ...current, [item.id]: value }));
  }

  async function handleSave() {
    setMessage(null);
    setFailures([]);

    // Validate everything first, so one bad value can't leave a half-saved batch the user didn't expect.
    const invalid = dirtyItems.filter((item) => {
      const typed = drafts[item.id].trim();
      return typed !== '' && !MONEY_PATTERN.test(typed);
    });
    if (invalid.length > 0) {
      setFailures(invalid.map((item) => ({ id: item.id, name: item.name, reason: 'Enter an amount of zero or more with at most 2 decimal places, or leave it blank.' })));
      setMessage({ tone: 'error', text: `${invalid.length} value${invalid.length === 1 ? ' is' : 's are'} not a valid amount — nothing was saved.` });
      return;
    }

    setSaving(true);
    const failed = [];
    let saved = 0;
    for (const item of dirtyItems) {
      const typed = drafts[item.id].trim();
      try {
        await posApi.updateMenuItem(item.id, { cost_price: typed === '' ? null : typed });
        saved += 1;
        setDrafts((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
      } catch (caught) {
        failed.push({ id: item.id, name: item.name, reason: caught instanceof ApiError ? caught.message : 'Could not save this item.' });
      }
    }
    setSaving(false);
    setFailures(failed);
    setMessage(
      failed.length === 0
        ? { tone: 'success', text: `Saved ${saved} cost price${saved === 1 ? '' : 's'}.` }
        : { tone: 'error', text: `Saved ${saved}; ${failed.length} could not be saved (listed below, still in the table).` }
    );
    if (saved > 0) await onSaved?.();
  }

  return (
    <div className={formStyles.form}>
      {message && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? formStyles.errorBanner : formStyles.hint}>
          {message.text}
        </p>
      )}
      {failures.length > 0 && (
        <ul className={formStyles.hint}>
          {failures.map((failure) => (
            <li key={failure.id}>
              {failure.name}: {failure.reason}
            </li>
          ))}
        </ul>
      )}

      {/* Outside the DataTable — its toolbar only renders while there are rows to show. */}
      <p className={formStyles.hint}>
        Cost price is what an item costs you to sell one, and it lets the Sales and margin reports show profit. Items sold from a stock recipe use their stock cost instead, so they are not editable
        here. {editableRows.length - missingCount} of {editableRows.length} editable item{editableRows.length === 1 ? ' has' : 's have'} a cost price.
      </p>
      <label className={formStyles.checkboxField}>
        <input className={formStyles.checkbox} type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} />
        <span className={formStyles.label}>Only items with no cost price ({missingCount})</span>
      </label>

      <DataTable
        title="Cost prices"
        state={rows.length === 0 ? 'empty' : visibleRows.length === 0 ? 'empty' : 'success'}
        emptyMessage={rows.length === 0 ? 'No menu items at this outlet yet.' : 'Every editable item already has a cost price.'}
        columns={[
          { key: 'category', label: 'Category', render: (row) => row.category ?? '—' },
          { key: 'name', label: 'Item' },
          { key: 'price', label: 'Selling price', align: 'right', render: (row) => <Money amount={row.price} currencyCode={currencyCode} /> },
          {
            key: 'cost_price',
            label: 'Cost price',
            align: 'right',
            render: (row) => {
              const kind = recipeKind(row.id);
              if (kind === 'compound') return 'From its recipe';
              if (kind === 'stock') {
                const stock = linkedStockItemFor(row.id);
                const zero = stock && Number(stock.purchase_cost) === 0;
                return zero ? 'From stock — no cost yet, receive stock' : 'From stock';
              }
              return (
                <input
                  className={formStyles.input}
                  // Text, not type="number": a number input reports '' for unparsable text, which would silently save as "clear the cost".
                  type="text"
                  inputMode="decimal"
                  aria-label={`Cost price for ${row.name}`}
                  value={valueFor(row)}
                  onChange={(event) => setDraft(row, event.target.value)}
                  disabled={isOffline || saving}
                />
              );
            },
          },
        ]}
        rows={visibleRows}
        rowKey={(row) => row.id}
        footer={
          <Button type="button" onClick={handleSave} loading={saving} disabled={isOffline || dirtyItems.length === 0}>
            {dirtyItems.length === 0 ? 'Save cost prices' : `Save ${dirtyItems.length} cost price${dirtyItems.length === 1 ? '' : 's'}`}
          </Button>
        }
      />
    </div>
  );
}
