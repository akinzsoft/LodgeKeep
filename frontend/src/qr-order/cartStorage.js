/**
 * The guest's cart, kept in `sessionStorage` per QR token, so a large order
 * survives a page reload or a trip to checkout and back — the menu screen
 * rebuilds from it. There is still no backend cart; this is only the
 * guest's own browser tab. Storage can be unavailable (private mode, blocked
 * site data), so every access is guarded and falls back to an empty cart.
 */

const key = (token) => `lodgekeep.qr-cart.${token}`;

/** `{ [menuItemId]: quantity }` for this token, or `{}`. */
export function loadCart(token) {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key(token)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0));
  } catch {
    return {};
  }
}

export function saveCart(token, cart) {
  try {
    const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0);
    if (lines.length === 0) window.sessionStorage.removeItem(key(token));
    else window.sessionStorage.setItem(key(token), JSON.stringify(Object.fromEntries(lines)));
  } catch {
    // A cart that cannot be remembered still works for this page view.
  }
}

export function clearCart(token) {
  try {
    window.sessionStorage.removeItem(key(token));
  } catch {
    // Nothing to clear.
  }
}
