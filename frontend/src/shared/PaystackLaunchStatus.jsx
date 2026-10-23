/**
 * What the user sees while the Paystack window is being opened (see `hooks/usePaystackLauncher.js`):
 * "Opening payment page…" first, and, if the window has not appeared after a few seconds, a link to the hosted
 * payment page for the same transaction.
 */
export function PaystackLaunchStatus({ opening, fallbackUrl, className }) {
  if (!opening && !fallbackUrl) return null;
  return (
    <div className={className}>
      {opening && <p role="status">Opening payment page…</p>}
      {fallbackUrl && (
        <p role="alert">
          The payment window did not open.{' '}
          <a href={fallbackUrl} target="_blank" rel="noreferrer">
            Open payment page
          </a>
        </p>
      )}
    </div>
  );
}
