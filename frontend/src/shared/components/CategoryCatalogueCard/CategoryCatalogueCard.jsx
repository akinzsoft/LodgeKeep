import { useState } from 'react';
import { Card } from '../Card/Card.jsx';
import { DataTable } from '../DataTable/DataTable.jsx';
import { Button } from '../Button/Button.jsx';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog.jsx';
import { ApiError } from '../../api/index.js';
import styles from './CategoryCatalogueCard.module.css';

/**
 * The shared shape behind Menu categories, Stock categories, and Expense
 * categories — three independently-built, near-identical "registered
 * catalogue" cards (register/rename/reorder/archive a small property-scoped
 * list a sibling entity picks from a dropdown instead of typing free text).
 * Every string/behavior that differs between the three real call sites is
 * an explicit prop — this component knows nothing about POS/stock/expenses.
 * `categories`/`onChanged` stay the caller's own responsibility
 * (list-fetching and refresh), matching every existing call site exactly.
 *
 * `renameHint`: `null` omits the rename-cascade paragraph entirely (used by
 * expense categories, whose `expense_category_id` is a live FK — no
 * cascade update happens on rename, so there is nothing to explain).
 *
 * `extraRows`/`selectedRowKey`/`onSelectRow` are an opt-in row-selection
 * mode, added for Stock items' own single-category view — every other
 * call site (Menu categories, Expense categories) omits all three and
 * renders exactly as before: a plain, non-clickable name cell, no
 * highlighted row, no extra rows appended. When `onSelectRow` IS supplied,
 * each row's name becomes a clickable selector and `extraRows` (rows this
 * card doesn't own or manage — e.g. an "Uncategorized" bucket, or a
 * category that's since been archived but still has items pointing at
 * it) are appended after the real, manageable categories, each keyed by
 * its own `key` rather than a real `id` and rendered with no Edit/Archive
 * actions at all.
 */
export function CategoryCatalogueCard({
  title,
  hint,
  namePlaceholder,
  countColumnLabel,
  renameHint = null,
  archiveConsequence,
  categories,
  onChanged,
  api, // { create({name, sortOrder}), update(id, {name, sortOrder}), archive(id) }
  extraRows = [], // [{ key, name, item_count }] — selectable, not manageable
  selectedRowKey = null,
  onSelectRow = null, // (row) => void
  noun = 'category', // lowercase; e.g. 'menu category' so two POS catalogues never both read as a bare "Category"
}) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const [form, setForm] = useState({ name: '', sort_order: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [archiving, setArchiving] = useState(null);

  async function handleCreate(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.create({ name: form.name, sortOrder: form.sort_order === '' ? undefined : Number(form.sort_order) });
      setForm({ name: '', sort_order: '' });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not add this ${noun}.`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(event) {
    event.preventDefault();
    setError(null);
    try {
      await api.update(editing.id, { name: editing.name, sortOrder: editing.sort_order === '' ? undefined : Number(editing.sort_order) });
      setEditing(null);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not save this ${noun}.`);
    }
  }

  async function confirmArchive() {
    const category = archiving;
    setArchiving(null);
    setError(null);
    try {
      await api.archive(category.id);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not archive this ${noun}.`);
    }
  }

  return (
    <Card title={title}>
      <p className={styles.hint}>{hint}</p>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      <form className={styles.row} onSubmit={handleCreate}>
        <label className={styles.field}>
          <span className={styles.label}>{Noun} name</span>
          <input className={styles.input} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={namePlaceholder} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Display order</span>
          <input className={styles.input} type="number" step="1" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} placeholder="0" />
        </label>
        <div className={styles.actionsRow}>
          <Button type="submit" loading={submitting}>
            Add {noun}
          </Button>
        </div>
      </form>

      <DataTable
        state={categories === null ? 'loading' : categories.length === 0 && extraRows.length === 0 ? 'empty' : 'success'}
        emptyMessage={`No ${noun.replace(/y$/, 'ies')} yet — add the first one above.`}
        columns={[
          {
            key: 'name',
            label: Noun,
            render: (row) =>
              onSelectRow ? (
                <button type="button" className={styles.rowSelectButton} onClick={() => onSelectRow(row)}>
                  {row.name}
                </button>
              ) : (
                row.name
              ),
          },
          { key: 'sort_order', label: 'Order', align: 'right', render: (row) => row.sort_order ?? '—' },
          { key: 'item_count', label: countColumnLabel, align: 'right' },
        ]}
        rows={[...(categories ?? []), ...extraRows]}
        rowKey={(row) => row.id ?? row.key}
        rowClassName={onSelectRow ? (row) => ((row.id ?? row.key) === selectedRowKey ? styles.selectedRow : undefined) : undefined}
        actions={(row) =>
          // extraRows (Uncategorized, an archived-but-still-referenced
          // category) carry no `id` — they aren't real rows in this
          // table, so there's nothing here to edit or archive.
          row.id === undefined ? null : (
            <>
              <Button size="compact" variant="ghost" onClick={() => setEditing({ id: row.id, name: row.name, sort_order: String(row.sort_order ?? 0) })}>
                Edit
              </Button>
              <Button size="compact" variant="ghost" onClick={() => setArchiving(row)}>
                Archive
              </Button>
            </>
          )
        }
      />

      {editing && (
        <form className={styles.row} onSubmit={handleSaveEdit} aria-label={`Edit ${noun}`}>
          <label className={styles.field}>
            <span className={styles.label}>Rename {noun}</span>
            <input className={styles.input} value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>New display order</span>
            <input className={styles.input} type="number" step="1" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: e.target.value })} />
          </label>
          <div className={styles.actionsRow}>
            <Button type="submit">Save {noun}</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
          {renameHint && <p className={styles.hint}>{renameHint}</p>}
        </form>
      )}

      {archiving && (
        <ConfirmDialog
          title={`Archive ${noun}`}
          consequence={`"${archiving.name}" ${archiveConsequence}`}
          confirmLabel="Archive"
          onConfirm={confirmArchive}
          onCancel={() => setArchiving(null)}
        />
      )}
    </Card>
  );
}
