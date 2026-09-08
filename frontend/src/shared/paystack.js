/**
 * Gap closure (user-reported): "the payment ... rendered a url paystack to
 * make payment cant it be done same page." Both Cashiering's own payment
 * form and the booking screen's "pay at the point of booking" card
 * (`shared/api/cashiering.js`'s `capturePaystackPayment`/
 * `startPaystackCheckout`) already receive a real Paystack `accessCode`
 * from the backend now — this is the one place that turns it into an
 * embedded, same-page checkout popup (Paystack's own Inline JS,
 * `resumeTransaction`) instead of the plain hosted-checkout link
 * (`authorizationUrl`) every payment attempt still also returns.
 *
 * This is the first third-party script this codebase has ever loaded
 * (CLAUDE.md's own module-boundary rule keeps every network call inside
 * `shared/api`, but Paystack's popup is not an HTTP call this app makes —
 * it is a script the GUEST'S OWN BROWSER must run to talk to Paystack
 * directly, the same reason Paystack's own docs ship it as a `<script>`,
 * not a fetch-able endpoint). Loaded lazily, on first use, rather than from
 * `index.html` — most sessions (front desk on a cash-only shift,
 * housekeeping, setup) never open a card-payment form at all, and nothing
 * here should cost them a network request.
 */

const SCRIPT_SRC = 'https://js.paystack.co/v2/inline.js';

let loadPromise = null;

export function loadPaystackInline() {
  if (typeof window !== 'undefined' && window.PaystackPop) {
    return Promise.resolve(window.PaystackPop);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.PaystackPop) resolve(window.PaystackPop);
      else reject(new Error('Paystack script loaded but PaystackPop is unavailable.'));
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Could not load the Paystack payment script.'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/**
 * Resumes an already-initialized transaction (`accessCode`, from
 * `capturePaystackPayment`/`startPaystackCheckout`'s own response) inside
 * Paystack's own embedded popup, on this page, with no redirect.
 *
 * The popup's own `onSuccess` is NEVER treated as proof the payment
 * actually captured — ARCHITECTURE.md §7's "a database transaction cannot
 * commit atomically with a payment provider" applies just as much to a
 * client-side callback as it does to a webhook; a callback can fire from
 * tampered client JS. Every caller must still reconcile through the real
 * `POST /cashiering/payments/:id/verify` afterwards — the exact same verify
 * call the "Verify" button on a still-pending payment already makes for
 * the webhook-unreachable-in-local-dev case. `onClose` fires for both a
 * genuine cancel and a reported success (Paystack calls both), so a caller
 * should treat it only as "the popup is gone, go verify" — never as
 * "the guest cancelled."
 *
 * @param {{accessCode: string, onClose: () => void}} params
 */
export async function openPaystackPopup({ accessCode, onClose }) {
  const PaystackPop = await loadPaystackInline();
  const popup = new PaystackPop();
  popup.resumeTransaction(accessCode, {
    onSuccess: () => onClose?.(),
    onCancel: () => onClose?.(),
    onClose: () => onClose?.(),
  });
}
