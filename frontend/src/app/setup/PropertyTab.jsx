import { useState } from 'react';
import { Card, DataTable, Button, Toast } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * PropertyTab — PRODUCT_REQUIREMENTS.md §3.19: "name, address, contact
 * details, timezone, currency ... opening business date." Contact details
 * (phone/email) and logo/brand colours are named in the same spec sentence
 * but have no backend field yet (the properties table carries
 * name/slug/address/timezone/base_currency/current_business_date/logo_url/
 * theme — logo_url/theme exist in the schema but no upload flow was built
 * this pass) — this form covers exactly what `POST/PATCH /properties`
 * accepts today.
 */
export function PropertyTab({ properties, onPropertiesChanged }) {
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  function emptyForm() {
    return { name: '', slug: '', timezone: '', base_currency: '', address: '', business_date: '' };
  }

  function startEdit(property) {
    setEditingId(property.id);
    setForm({
      name: property.name,
      slug: property.slug,
      timezone: property.timezone,
      base_currency: property.base_currency,
      address: property.address ?? '',
      business_date: property.current_business_date ?? '',
    });
  }

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (editingId) {
        await setupApi.updateProperty(editingId, {
          name: form.name,
          timezone: form.timezone,
          base_currency: form.base_currency,
          address: form.address || null,
          current_business_date: form.business_date || null,
        });
        setToast('Property updated');
      } else {
        await setupApi.createProperty({
          name: form.name,
          slug: form.slug,
          timezone: form.timezone,
          base_currency: form.base_currency,
          address: form.address || undefined,
          business_date: form.business_date || undefined,
        });
        setToast('Property created');
        startCreate();
      }
      await onPropertiesChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the property.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <DataTable
        title="Properties"
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'slug', label: 'Slug' },
          { key: 'timezone', label: 'Timezone' },
          { key: 'base_currency', label: 'Currency' },
          { key: 'current_business_date', label: 'Business date', render: (row) => row.current_business_date ?? '—' },
        ]}
        rows={properties}
        rowKey={(row) => row.id}
        state={properties.length === 0 ? 'empty' : 'success'}
        emptyMessage="No properties yet — create the first one below."
        actions={(row) => (
          <Button variant="ghost" size="compact" onClick={() => startEdit(row)}>
            Edit
          </Button>
        )}
      />

      <Card title={editingId ? 'Edit property' : 'Add a property'}>
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleSubmit}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Name</span>
            <input
              className={formStyles.input}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </label>

          {!editingId && (
            <label className={formStyles.field}>
              <span className={formStyles.label}>Slug</span>
              <input
                className={formStyles.input}
                value={form.slug}
                onChange={(event) => setForm({ ...form, slug: event.target.value })}
                placeholder="alpha-hotels-downtown"
                required
              />
            </label>
          )}

          <label className={formStyles.field}>
            <span className={formStyles.label}>Timezone</span>
            <input
              className={formStyles.input}
              value={form.timezone}
              onChange={(event) => setForm({ ...form, timezone: event.target.value })}
              placeholder="Africa/Lagos"
              required
            />
          </label>

          <label className={formStyles.field}>
            <span className={formStyles.label}>Base currency</span>
            <input
              className={formStyles.input}
              value={form.base_currency}
              onChange={(event) => setForm({ ...form, base_currency: event.target.value.toUpperCase() })}
              placeholder="NGN"
              maxLength={3}
              required
            />
          </label>

          <label className={formStyles.field}>
            <span className={formStyles.label}>Address</span>
            <input
              className={formStyles.input}
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
            />
          </label>

          <label className={formStyles.field}>
            <span className={formStyles.label}>{editingId ? 'Business date' : 'Opening business date'}</span>
            <input
              className={formStyles.input}
              type="date"
              value={form.business_date}
              onChange={(event) => setForm({ ...form, business_date: event.target.value })}
            />
          </label>

          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={submitting}>
              {editingId ? 'Save changes' : 'Create property'}
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" onClick={startCreate}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </Card>

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
