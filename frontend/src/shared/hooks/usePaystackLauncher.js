import { useCallback, useEffect, useRef, useState } from 'react';
import { openPaystackPopup } from '../paystack.js';

/** How long the app waits for the checkout window before offering the plain link. */
export const CHECKOUT_FALLBACK_MS = 5000;

/** Paystack's hosted page for a transaction is always /<access_code>; used only when the server sent no URL. */
export function paystackCheckoutUrl(accessCode) {
  return accessCode ? `https://checkout.paystack.com/${accessCode}` : null;
}

/**
 * Opens the Paystack checkout window safely.
 *
 * - Single flight: while one launch is in progress, another `launch` does nothing and resolves `'ignored'`.
 * - `opening` is true from the call until the window reports it is up (or is closed).
 * - If the window has not reported in after `fallbackMs`, `fallbackUrl` is set (the server's authorization URL, or the
 *   hosted page derived from the access code) so the user can open the payment page by hand.
 *
 * `launch` resolves `'closed'` when the popup closes (success, cancel and plain close all look the same: the caller
 * must verify with the server), and rejects if the Paystack script cannot be loaded.
 */
export function usePaystackLauncher({ fallbackMs = CHECKOUT_FALLBACK_MS } = {}) {
  const [opening, setOpening] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState(null);
  const inFlight = useRef(false);
  const timer = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const launch = useCallback(
    ({ accessCode, authorizationUrl }) => {
      if (inFlight.current) return Promise.resolve('ignored');
      inFlight.current = true;
      setOpening(true);
      setFallbackUrl(null);
      const url = authorizationUrl || paystackCheckoutUrl(accessCode);
      const finish = () => {
        clearTimeout(timer.current);
        inFlight.current = false;
        if (mounted.current) {
          setOpening(false);
          setFallbackUrl(null);
        }
      };
      timer.current = setTimeout(() => {
        if (mounted.current && url) setFallbackUrl(url);
      }, fallbackMs);

      return new Promise((resolve, reject) => {
        let closed = false;
        openPaystackPopup({
          accessCode,
          onOpen: () => {
            // The window is up: no fallback needed, and the button no longer waits.
            clearTimeout(timer.current);
            if (mounted.current) {
              setOpening(false);
              setFallbackUrl(null);
            }
          },
          onError: () => {
            if (mounted.current && url) setFallbackUrl(url);
          },
          onClose: () => {
            if (closed) return;
            closed = true;
            finish();
            resolve('closed');
          },
        }).catch((error) => {
          // Script failed to load: show the link at once rather than after the wait.
          clearTimeout(timer.current);
          inFlight.current = false;
          if (mounted.current) {
            setOpening(false);
            if (url) setFallbackUrl(url);
          }
          reject(error);
        });
      });
    },
    [fallbackMs]
  );

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    inFlight.current = false;
    setOpening(false);
    setFallbackUrl(null);
  }, []);

  return { launch, opening, fallbackUrl, reset };
}
