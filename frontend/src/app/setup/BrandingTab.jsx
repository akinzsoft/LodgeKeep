import { useState } from 'react';
import { Card, Button, Toast } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';
import styles from './BrandingTab.module.css';

const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
// Below this width a logo is enlarged on high-density screens and prints soft.
const MIN_CRISP_WIDTH = 480;

/**
 * BrandingTab — the active property's logo (user-requested: "in SETUP add
 * where the logo can be uploaded, which should show in receipts and mails;
 * ensure it fits in and looks fine"). The logo used to be reachable only by
 * clicking Edit on a property; this tab makes it a first-class Setup
 * destination with live previews of exactly where it appears:
 * - a printed POS receipt (80mm roll, grayscale, same sizing rules as
 *   RegisterTab's printable receipt), and
 * - the header of every email (the same 240×72 box `email-layout.js` fits
 *   logos into, without stretching).
 *
 * Upload/replace/remove go straight to `POST|DELETE /properties/:id/logo`
 * (`setup.manage`); a lower-tier account sees the real 403.
 */
export function BrandingTab({ activeProperty, onPropertiesChanged, isOffline = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [inputKey, setInputKey] = useState(0);
  const [naturalSize, setNaturalSize] = useState(null);

  if (!activeProperty) {
    return <p className={formStyles.hint}>Select an active property to set its branding.</p>;
  }

  const logoUrl = activeProperty.logo_url ?? null;

  async function handleFile(file) {
    if (!file) return;
    setError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setError('The logo must be a JPG, PNG, or WebP image.');
      setInputKey((key) => key + 1);
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('The logo must be 2 MB or smaller.');
      setInputKey((key) => key + 1);
      return;
    }
    setBusy(true);
    try {
      await setupApi.uploadPropertyLogo(activeProperty.id, file);
      setNaturalSize(null);
      setToast('Logo updated');
      await onPropertiesChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not upload the logo.');
    } finally {
      setBusy(false);
      setInputKey((key) => key + 1);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      await setupApi.removePropertyLogo(activeProperty.id);
      setNaturalSize(null);
      setToast('Logo removed');
      await onPropertiesChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the logo.');
    } finally {
      setBusy(false);
    }
  }

  const lowResolution = naturalSize && naturalSize.width < MIN_CRISP_WIDTH;

  return (
    <div className={styles.layout}>
      <Card title={`Logo — ${activeProperty.name}`}>
        <p className={formStyles.hint}>
          Your logo appears at the top of every printed POS receipt and every email guests and staff receive from {activeProperty.name}.
        </p>
        {error && (
          <p role="alert" className={formStyles.errorBanner}>
            {error}
          </p>
        )}

        <div className={styles.current}>
          {logoUrl ? (
            <img
              className={styles.currentLogo}
              src={logoUrl}
              alt={`${activeProperty.name} logo`}
              onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            />
          ) : (
            <span className={formStyles.hint}>No logo yet — your property name is used in its place.</span>
          )}
        </div>
        {naturalSize && (
          <p className={formStyles.hint}>
            {naturalSize.width} × {naturalSize.height} px
            {lowResolution ? ' — this is small and may look soft; a logo at least 480 px wide prints and displays crisply.' : ''}
          </p>
        )}

        <div className={formStyles.actionsRow}>
          <label className={styles.uploadButton} aria-disabled={busy || isOffline}>
            <input
              key={inputKey}
              className={styles.fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy || isOffline}
              aria-label={logoUrl ? 'Replace logo' : 'Upload logo'}
              onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
            />
            <span aria-hidden="true">{busy ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}</span>
          </label>
          {logoUrl && (
            <Button type="button" variant="ghost" disabled={busy || isOffline} onClick={handleRemove}>
              Remove logo
            </Button>
          )}
        </div>
        {isOffline && <p className={formStyles.hint}>You are offline — the logo can be changed once you reconnect.</p>}

        <ul className={styles.tips}>
          <li>PNG with a transparent background works best; JPG and WebP are accepted too (up to 2 MB).</li>
          <li>A wide, landscape logo at least 480 px wide fits both receipts and emails best.</li>
          <li>Receipts print in black and white, so check the logo still reads clearly in grey below.</li>
        </ul>
      </Card>

      <div className={styles.previews}>
        <Card title="On a printed receipt">
          <div className={styles.receiptPreview} aria-label="Receipt preview">
            {logoUrl ? (
              <img className={styles.receiptLogo} src={logoUrl} alt="" />
            ) : null}
            <p className={styles.receiptTitle}>{activeProperty.name}</p>
            {activeProperty.address && <p className={styles.receiptCentered}>{activeProperty.address}</p>}
            <p className={styles.receiptCentered}>Receipt #1024</p>
            <hr className={styles.receiptRule} />
            <p className={styles.receiptRow}>
              <span>2 × Sample item</span>
              <span>—</span>
            </p>
            <hr className={styles.receiptRule} />
            <p className={styles.receiptCentered}>Thank you!</p>
          </div>
        </Card>

        <Card title="In emails">
          <div className={styles.emailPreview} aria-label="Email preview">
            <div className={styles.emailHeader}>
              {logoUrl ? <img className={styles.emailLogo} src={logoUrl} alt="" /> : <span className={styles.emailWordmark}>{activeProperty.name}</span>}
            </div>
            <div className={styles.emailCard}>
              <p className={styles.emailHeading}>Your stay is confirmed</p>
              <p className={styles.emailLine}>Dear guest, thank you for choosing {activeProperty.name}…</p>
            </div>
            <p className={styles.emailFooter}>{activeProperty.name}</p>
          </div>
        </Card>
      </div>

      {toast && (
        <div className={formStyles.toastLayer}>
          <Toast message={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
