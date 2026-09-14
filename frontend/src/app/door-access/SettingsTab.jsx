import { useState } from 'react';
import { Button, Card } from '../../shared/components/index.js';
import { doorAccessApi, ApiError } from '../../shared/api/index.js';
import { ADAPTER_LABELS } from './format.js';
import styles from './DoorAccess.module.css';

/**
 * PRODUCT_REQUIREMENTS.md §3.19's lock-system setting: an adapter picker
 * defaulting to None that "must state plainly what the chosen option
 * delivers". Only the offline, manual-import adapters are offered — no
 * networked adapter has been integrated, so none is listed as if it were.
 */
const WHAT_IT_DELIVERS = {
  none: 'No door events are imported and no occupancy checks run.',
  hiread_prousb:
    'Retrospective detection — staff must pull the audit trail from each lock with the handheld reader and upload the exported file. No live alerts.',
  generic_csv:
    'Retrospective detection from any lock software that can export a spreadsheet. Staff map its columns on first import. No live alerts.',
};

export function SettingsTab({ config, isOffline = false, onSaved }) {
  const [adapter, setAdapter] = useState(config.adapter);
  const [grace, setGrace] = useState(String(config.postCheckoutGraceMinutes));
  // Empty string means "no retention window configured" (null or, from an
  // older cached/mocked config shape, simply absent) — a real, distinct
  // choice from a number, never treated as an error until the property
  // actually wants automatic purging.
  const [retention, setRetention] = useState(config.retentionDays == null ? '' : String(config.retentionDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const retentionInvalid = retention !== '' && (!Number.isInteger(Number(retention)) || Number(retention) < 1 || Number(retention) > 3650);

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await doorAccessApi.updateConfig({
        adapter,
        postCheckoutGraceMinutes: Number(grace),
        retentionDays: retention === '' ? null : Number(retention),
      });
      onSaved(next);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save door access settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Lock system">
      <form className={styles.form} onSubmit={handleSubmit}>
        {error && (
          <p className={styles.errorBanner} role="alert">
            {error}
          </p>
        )}
        {saved && <p className={styles.notice}>Settings saved.</p>}
        {isOffline && <p className={styles.notice}>You are offline. Saving settings is disabled until connectivity returns.</p>}

        <div className={styles.row}>
          {/* Each field's help paragraph is a sibling of, not nested inside,
              its <label> — a wrapping <label> computes its accessible name
              from ALL of its text content, so a help paragraph nested
              inside one (as every field here originally had it) silently
              became part of the field's own spoken name for assistive
              tech, and broke an exact-match `getByLabelText` query the
              same way. Explicit htmlFor/id keeps the name to just the
              short label text. */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="door-access-adapter">
              Lock system
            </label>
            <select id="door-access-adapter" className={styles.select} value={adapter} onChange={(e) => setAdapter(e.target.value)}>
              {Object.entries(ADAPTER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className={styles.help}>{WHAT_IT_DELIVERS[adapter]}</p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="door-access-grace">
              Grace period after checkout (minutes)
            </label>
            <input
              id="door-access-grace"
              className={styles.input}
              type="number"
              min="0"
              max="720"
              step="1"
              value={grace}
              onChange={(e) => setGrace(e.target.value)}
            />
            <p className={styles.help}>
              A guest card opening the room this soon after a recorded checkout (for example to fetch a forgotten bag) is not
              flagged.
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="door-access-retention">
              Door event retention (days)
            </label>
            <input
              id="door-access-retention"
              className={styles.input}
              type="number"
              min="1"
              max="3650"
              step="1"
              placeholder="Not set — kept indefinitely"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
            <p className={styles.help}>
              {retention === ''
                ? 'No automatic purge is configured — door events are kept indefinitely until you set a number of days.'
                : `Door events older than ${retention} day${retention === '1' ? '' : 's'} are deleted automatically, once a day. An event still linked to an alert or a stay confirmation is never deleted, regardless of age.`}
              {' '}Clear this field to turn automatic purging back off.
            </p>
          </div>
        </div>

        <div className={styles.actionsRow}>
          <Button type="submit" disabled={isOffline || saving || grace === '' || retentionInvalid}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
