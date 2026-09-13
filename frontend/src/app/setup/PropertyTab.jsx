import { useState } from 'react';
import { Card, DataTable, Button, Toast } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * PropertyTab — PRODUCT_REQUIREMENTS.md §3.19: "name, address, contact
 * details, timezone, currency ... opening business date." Contact details
 * (phone/email) and brand colours are named in the same spec sentence but
 * have no backend field yet — this form covers exactly what
 * `POST/PATCH /properties` accepts today.
 *
 * The logo (user-requested: "each tenant admin can upload their logo which
 * will appear in receipt and mails") is its own card while editing a
 * property — uploaded straight away through `POST /properties/:id/logo`
 * (`setup.manage`), not part of the form's Save, since a file is not a
 * field the PATCH carries.
 *
 * The MFA checkbox (gap closure, user-reported: "enable or disable mfa
 * verication code on the setup") only appears while editing — it has no
 * meaning at creation time, the same reasoning the slug/business-date
 * fields already apply for the opposite case.
 */
const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function PropertyTab({ properties, onPropertiesChanged }) {
  const [editingId, setEditingId] = useState(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState(null);
  const [logoInputKey, setLogoInputKey] = useState(0);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  function emptyForm() {
    return { name: '', slug: '', timezone: '', base_currency: '', address: '', business_date: '', mfa_required_for_admin_roles: true };
  }

  function startEdit(property) {
    setEditingId(property.id);
    setLogoError(null);
    setForm({
      name: property.name,
      slug: property.slug,
      timezone: property.timezone,
      base_currency: property.base_currency,
      address: property.address ?? '',
      business_date: property.current_business_date ?? '',
      // Gap closure (user-reported): "enable or disable mfa verication
      // code on the setup." Defaults true (matches the column's own
      // NOT NULL DEFAULT true) if a caller somehow lacks the field.
      mfa_required_for_admin_roles: property.mfa_required_for_admin_roles ?? true,
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
          mfa_required_for_admin_roles: form.mfa_required_for_admin_roles,
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

  const editingProperty = editingId ? properties.find((p) => String(p.id) === String(editingId)) : null;

  async function handleLogoChosen(file) {
    if (!file) return;
    setLogoError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError('The logo must be a JPG, PNG, or WebP image.');
      setLogoInputKey((key) => key + 1);
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('The logo must be 2 MB or smaller.');
      setLogoInputKey((key) => key + 1);
      return;
    }
    setLogoBusy(true);
    try {
      await setupApi.uploadPropertyLogo(editingId, file);
      setToast('Logo updated');
      await onPropertiesChanged();
    } catch (caught) {
      setLogoError(caught instanceof ApiError ? caught.message : 'Could not upload the logo.');
    } finally {
      setLogoBusy(false);
      setLogoInputKey((key) => key + 1);
    }
  }

  async function handleRemoveLogo() {
    setLogoError(null);
    setLogoBusy(true);
    try {
      await setupApi.removePropertyLogo(editingId);
      setToast('Logo removed');
      await onPropertiesChanged();
    } catch (caught) {
      setLogoError(caught instanceof ApiError ? caught.message : 'Could not remove the logo.');
    } finally {
      setLogoBusy(false);
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

          {editingId && (
            <label className={formStyles.checkboxField}>
              <input
                type="checkbox"
                className={formStyles.checkbox}
                checked={form.mfa_required_for_admin_roles}
                onChange={(event) => setForm({ ...form, mfa_required_for_admin_roles: event.target.checked })}
              />
              <span className={formStyles.label}>Require a verification code (MFA) for admin/super admin sign-in</span>
            </label>
          )}

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

      {editingProperty && (
        <Card title="Logo">
          <p className={formStyles.hint}>Shown at the top of printed POS receipts and every email guests and staff receive. JPG, PNG, or WebP, up to 2 MB — a wide logo on a transparent or white background works best.</p>
          {logoError && (
            <p role="alert" className={formStyles.errorBanner}>
              {logoError}
            </p>
          )}
          <div className={formStyles.logoRow}>
            {editingProperty.logo_url ? (
              <img className={formStyles.logoPreview} src={editingProperty.logo_url} alt={`${editingProperty.name} logo`} />
            ) : (
              <span className={formStyles.hint}>No logo yet — the property name is used instead.</span>
            )}
          </div>
          <div className={formStyles.actionsRow}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>{editingProperty.logo_url ? 'Replace logo' : 'Upload logo'}</span>
              <input
                key={logoInputKey}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={logoBusy}
                onChange={(event) => handleLogoChosen(event.target.files?.[0] ?? null)}
              />
            </label>
            {editingProperty.logo_url && (
              <Button type="button" variant="ghost" disabled={logoBusy} onClick={handleRemoveLogo}>
                Remove logo
              </Button>
            )}
          </div>
        </Card>
      )}

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
