import { useEffect, useRef, useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * OutletCategoriesCard — which categories an outlet sells (user-requested:
 * "when I create an outlet I can easily choose any category I want in that
 * outlet, which will contain all the items"). A checklist of the property's
 * shared categories; the outlet sells every item in the ticked ones,
 * including items added to them later. Saving replaces the whole set
 * (`PUT /pos/outlets/:id/categories`, `pos.manage`).
 */
export function OutletCategoriesCard({ outletId, outletName, isOffline = false, onSaved }) {
  const [categories, setCategories] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [saved, setSaved] = useState(new Set());
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  // A slow answer for the outlet just switched away from must not land.
  const outletRef = useRef(outletId);

  async function load() {
    const requestedFor = outletId;
    try {
      const list = await posApi.listMenuCategories();
      if (outletRef.current !== requestedFor) return;
      const carried = new Set(list.filter((row) => (row.outlet_ids ?? []).includes(String(requestedFor))).map((row) => String(row.id)));
      setCategories(list);
      setChosen(carried);
      setSaved(carried);
      setError(null);
    } catch (caught) {
      if (outletRef.current !== requestedFor) return;
      setCategories([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the categories.');
    }
  }

  useEffect(() => {
    outletRef.current = outletId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-then-fetch when the outlet changes
    setCategories(null);
    setNotice(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `outletId` changing only
  }, [outletId]);

  function toggle(id) {
    setNotice(null);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const dirty = chosen.size !== saved.size || [...chosen].some((id) => !saved.has(id));

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await posApi.setOutletCategories(outletId, [...chosen]);
      setSaved(new Set(chosen));
      setNotice(`${outletName} now sells ${chosen.size === 1 ? '1 category' : `${chosen.size} categories`}.`);
      onSaved?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the categories.');
    } finally {
      setSaving(false);
    }
  }

  // Archived categories are not offered, except one this outlet still carries (so unticking it stays possible).
  const shown = (categories ?? []).filter((row) => row.status === 'active' || saved.has(String(row.id)));

  return (
    <Card title={`Categories sold at ${outletName}`}>
      <p className={formStyles.hint}>
        Tick the categories this outlet sells. It sells every item in them, including items added later. Categories and items are created once, in
        the Catalogue, and can be sold at any number of outlets.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={formStyles.hint}>
          {notice}
        </p>
      )}
      {categories === null ? (
        <p className={formStyles.hint}>Loading categories…</p>
      ) : shown.length === 0 ? (
        <p className={formStyles.hint}>No categories yet — add some in the Catalogue first.</p>
      ) : (
        <form className={formStyles.form} onSubmit={handleSave}>
          <fieldset className={formStyles.checkboxGroup}>
            <legend className={formStyles.label}>Categories</legend>
            {shown.map((row) => (
              <label key={row.id} className={formStyles.checkboxField}>
                <input className={formStyles.checkbox} type="checkbox" checked={chosen.has(String(row.id))} onChange={() => toggle(String(row.id))} disabled={isOffline || saving} />
                <span>
                  {row.name}
                  <span className={formStyles.hint}>
                    {' '}
                    — {row.item_count === 1 ? '1 item' : `${row.item_count} items`}
                    {row.status !== 'active' ? ' (archived)' : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className={formStyles.actionsRow}>
            <Button type="button" variant="ghost" disabled={isOffline || saving} onClick={() => setChosen(new Set(shown.filter((row) => row.status === 'active').map((row) => String(row.id))))}>
              Select all
            </Button>
            <Button type="submit" loading={saving} disabled={isOffline || !dirty}>
              Save categories
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
