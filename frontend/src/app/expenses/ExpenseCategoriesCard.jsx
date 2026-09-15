import { useState } from 'react';
import { Card, DataTable, Button, ConfirmDialog } from '../../shared/components/index.js';
import { expensesApi, ApiError } from '../../shared/api/index.js';
import formStyles from './ExpensesForm.module.css';

/**
 * ExpenseCategoriesCard — mirrors `StockCategoriesCard.jsx`'s exact CRUD
 * shape. Register, rename, reorder, and archive (refused while any
 * non-voided expense or active recurring schedule still uses it).
 * Unlike stock's own copied-name-string categories, `expense_category_id`
 * is a real, live foreign key — a rename needs no cascade explanation,
 * since the join always resolves the current name automatically.
 */
export function ExpenseCategoriesCard({ categories, onChanged }) {
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
      await expensesApi.createExpenseCategory({ name: form.name, sortOrder: form.sort_order === '' ? undefined : Number(form.sort_order) });
      setForm({ name: '', sort_order: '' });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add this category.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(event) {
    event.preventDefault();
    setError(null);
    try {
      await expensesApi.updateExpenseCategory(editing.id, { name: editing.name, sortOrder: editing.sort_order === '' ? undefined : Number(editing.sort_order) });
      setEditing(null);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this category.');
    }
  }

  async function confirmArchive() {
    const category = archiving;
    setArchiving(null);
    setError(null);
    try {
      await expensesApi.archiveExpenseCategory(category.id);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not archive this category.');
    }
  }

  return (
    <Card title="Expense categories">
      <p className={formStyles.hint}>Categories are shared across every expense and recurring schedule at this property.</p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <form className={formStyles.row} onSubmit={handleCreate}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Category name</span>
          <input className={formStyles.input} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Utilities" required />
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Display order</span>
          <input className={formStyles.input} type="number" step="1" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} placeholder="0" />
        </label>
        <div className={formStyles.actionsRow}>
          <Button type="submit" loading={submitting}>
            Add category
          </Button>
        </div>
      </form>

      <DataTable
        state={categories === null ? 'loading' : categories.length === 0 ? 'empty' : 'success'}
        emptyMessage="No categories yet — add the first one above."
        columns={[
          { key: 'name', label: 'Category' },
          { key: 'sort_order', label: 'Order', align: 'right' },
          { key: 'item_count', label: 'Expenses', align: 'right' },
        ]}
        rows={categories ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button size="compact" variant="ghost" onClick={() => setEditing({ id: row.id, name: row.name, sort_order: String(row.sort_order ?? 0) })}>
              Edit
            </Button>
            <Button size="compact" variant="ghost" onClick={() => setArchiving(row)}>
              Archive
            </Button>
          </>
        )}
      />

      {editing && (
        <form className={formStyles.row} onSubmit={handleSaveEdit} aria-label="Edit category">
          <label className={formStyles.field}>
            <span className={formStyles.label}>Rename category</span>
            <input className={formStyles.input} value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>New display order</span>
            <input className={formStyles.input} type="number" step="1" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: e.target.value })} />
          </label>
          <div className={formStyles.actionsRow}>
            <Button type="submit">Save category</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {archiving && (
        <ConfirmDialog
          title="Archive category"
          consequence={`"${archiving.name}" will no longer be offered when recording an expense or a recurring schedule. A category still in use cannot be archived — move those items first.`}
          confirmLabel="Archive"
          onConfirm={confirmArchive}
          onCancel={() => setArchiving(null)}
        />
      )}
    </Card>
  );
}
