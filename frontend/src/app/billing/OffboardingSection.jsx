import { useEffect, useState } from 'react';
import { Card, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { offboardingApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './BillingScreen.module.css';

/** DESIGN_SYSTEM.md §1: status is always a filled pill with a text label, never colour alone. `tenant_data_exports.status` -> tone/label, owned here since this is the one screen that reads it. */
const EXPORT_STATUS = {
  pending: { tone: 'neutral', label: 'Preparing' },
  processing: { tone: 'warning', label: 'Preparing' },
  completed: { tone: 'success', label: 'Ready to download' },
  failed: { tone: 'danger', label: 'Failed' },
};

/**
 * OffboardingSection — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 * Lives inside `BillingScreen` rather than as its own top-level nav item —
 * the same "closely related admin-tier screens share one page" reasoning
 * `ReferenceDataTab`'s own header already established, and this tenant's
 * commercial relationship with Planmsys (its subscription, and now its
 * exit from the platform) is one coherent story, not two separate ones.
 * Gated by the caller (`BillingScreen`'s own `offboarding.manage` reads —
 * see `getOffboardingStatus`'s own real backend 403 for a manager without
 * it) rather than a client-side role check, per this codebase's own
 * "no client-side check hides the button" convention.
 *
 * A tenant that has already requested offboarding is STILL reachable and
 * read-only (`src/shared/tenant-lifecycle.js`'s own header) — this
 * section's own retry/download actions are the specific mutations
 * `src/app.js` deliberately carves out of that read-only gate so this
 * screen doesn't lock itself out the moment it does its job.
 */
export function OffboardingSection({ isOffline = false }) {
  const [status, setStatus] = useState(null); // { status, offboardingRequestedAt, retentionExpiresAt, latestExport }
  const [error, setError] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  async function reload() {
    setError(null);
    try {
      setStatus(await offboardingApi.getOffboardingStatus());
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not load offboarding status.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reload();
  }, []);

  async function handleConfirmRequest(reason) {
    setRequesting(true);
    setActionError(null);
    try {
      await offboardingApi.requestOffboarding(reason);
      setConfirmOpen(false);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not submit the offboarding request.');
    } finally {
      setRequesting(false);
    }
  }

  async function handleRetry(exportId) {
    setRetryingId(exportId);
    setActionError(null);
    try {
      await offboardingApi.retryExport(exportId);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not retry the export.');
    } finally {
      setRetryingId(null);
    }
  }

  async function handleDownload(exportId) {
    setDownloadingId(exportId);
    setActionError(null);
    try {
      const blob = await offboardingApi.downloadExport(exportId);
      triggerDownload(blob, `tenant-data-export-${exportId}.json`);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not download the export.');
    } finally {
      setDownloadingId(null);
    }
  }

  const cardState = status === null ? (error ? 'error' : 'loading') : 'success';
  const isOffboarding = status?.status === 'offboarding';
  const latestExport = status?.latestExport ?? null;
  const exportStatusInfo = latestExport ? EXPORT_STATUS[latestExport.status] ?? { tone: 'neutral', label: latestExport.status } : null;

  return (
    <Card title="Offboarding & data export" state={cardState} errorMessage={error}>
      {status && (
        <div className={styles.summaryRow}>
          {!isOffboarding && (
            <>
              <p className={styles.paymentPanelHint}>
                Leaving? Requesting offboarding makes your account read-only and starts preparing a complete, downloadable export of your own
                guests, reservations, folios, and operational history. Your data is retained for 30 days after the request, in case you change your
                mind or need to download it again.
              </p>
              {actionError && (
                <p role="alert" className={styles.errorBanner}>
                  {actionError}
                </p>
              )}
              <div className={styles.actionsRow}>
                <Button type="button" disabled={isOffline} onClick={() => setConfirmOpen(true)}>
                  Request offboarding
                </Button>
              </div>
            </>
          )}

          {isOffboarding && (
            <>
              <div className={styles.summaryLine}>
                <span className={styles.summaryLabel}>Status</span>
                <StatusPill tone="warning" label="Offboarding — read-only" />
              </div>
              <div className={styles.summaryLine}>
                <span className={styles.summaryLabel}>Requested</span>
                <span>{status.offboardingRequestedAt}</span>
              </div>
              <div className={styles.summaryLine}>
                <span className={styles.summaryLabel}>Data retained until</span>
                <span>{status.retentionExpiresAt}</span>
              </div>
              <p className={styles.paymentPanelHint}>
                Your account can still be reached to check this status and download your export, but every other write is disabled. Contact support
                to reverse this before the retention window ends.
              </p>

              {actionError && (
                <p role="alert" className={styles.errorBanner}>
                  {actionError}
                </p>
              )}

              {latestExport && (
                <div className={styles.paymentPanel}>
                  <div className={styles.summaryLine}>
                    <span className={styles.summaryLabel}>Export</span>
                    <StatusPill tone={exportStatusInfo.tone} label={exportStatusInfo.label} />
                  </div>
                  {latestExport.status === 'failed' && latestExport.failedReason && <p className={styles.paymentPanelHint}>{latestExport.failedReason}</p>}
                  {latestExport.downloadedAt && <p className={styles.paymentPanelHint}>Last downloaded {latestExport.downloadedAt}.</p>}
                  <div className={styles.actionsRow}>
                    {latestExport.status === 'completed' && (
                      <Button type="button" disabled={isOffline} loading={downloadingId === latestExport.id} onClick={() => handleDownload(latestExport.id)}>
                        Download export
                      </Button>
                    )}
                    {latestExport.status === 'failed' && (
                      <Button type="button" disabled={isOffline} loading={retryingId === latestExport.id} onClick={() => handleRetry(latestExport.id)}>
                        Retry export
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {confirmOpen && (
        <ConfirmDialog
          title="Request offboarding?"
          consequence="Your account will immediately become read-only and a full export of your data will start preparing. This does not delete anything — your data is retained for 30 days, and a platform administrator can reverse this before then."
          requireReason
          confirmLabel={requesting ? 'Requesting…' : 'Request offboarding'}
          onConfirm={handleConfirmRequest}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </Card>
  );
}
