import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Card, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { qrOrderingApi, ApiError } from '../../shared/api/index.js';
import styles from '../QrOrderScreen.module.css';
import formStyles from '../QrOrderForm.module.css';

/**
 * MenuScreen — the guest's real entry point, exactly where a real scan of
 * the printed QR sticker lands (`QrOrderApp.jsx`'s own header). Fetches the
 * real outlet menu for this token (`GET /qr-order/:token/menu`) and builds
 * a cart entirely in local component state — no backend "cart" resource
 * exists, matching PLAN.md Phase 6's own confirmed scope.
 *
 * `pos_menu_items` carries no currency column of its own — the currency
 * shown here is hardcoded to `NGN`, the same convention `SetupTab.jsx`'s
 * own POS menu-item table already established for the identical reason
 * (this codebase's own POS endpoints have never returned a currency code
 * alongside a menu item's price; see this branch's own deviation notes).
 *
 * ── PAYMENT METHOD, A REAL DEVIATION FROM THE ORIGINAL BRIEF ─────────────
 *
 * The brief for this screen assumed `GET .../menu`'s own response discloses
 * whether the scanned token is a `room` or `table` token, so "Room charge"
 * could be hidden for a table sticker. Reading the real backend
 * (`qr-ordering/service.js`'s `getMenuForToken`) shows it returns only
 * `{outlet: {id, name, type}, items}` — `outlet.type` is the OUTLET's own
 * type (bar/restaurant/...), never the scanned token's `room`/`table` type,
 * and no route on this anonymous surface discloses the token's type ahead
 * of an actual order attempt. Rather than guess, both payment methods are
 * always offered here — the real backend rejects `room_charge` against a
 * table token with a plain, readable `422 WRONG_PAYMENT_METHOD`
 * ("Charge-to-room is only available for a room QR code."), surfaced
 * verbatim on the checkout screen if it's ever actually chosen wrongly —
 * the same "no client-side check hides a control, the real backend error is
 * what's shown" convention this codebase already applies everywhere else
 * (e.g. `SetupTab.jsx`'s own header for `pos.manage`-gated actions).
 */
export function MenuScreen() {
  const { token } = useOutletContext();
  const navigate = useNavigate();

  const [menu, setMenu] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState({}); // menuItemId -> quantity
  const [paymentMethod, setPaymentMethod] = useState('card');

  useEffect(() => {
    let cancelled = false;
    qrOrderingApi
      .getMenu(token)
      .then((result) => {
        if (!cancelled) setMenu(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        setMenu({ outlet: null, items: [] });
        setError(caught instanceof ApiError ? caught.message : 'Could not load the menu.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const itemsById = useMemo(() => Object.fromEntries((menu?.items ?? []).map((item) => [item.id, item])), [menu]);

  const categories = useMemo(() => {
    const grouped = new Map();
    for (const item of menu?.items ?? []) {
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category).push(item);
    }
    return [...grouped.entries()];
  }, [menu]);

  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, quantity]) => quantity > 0)
        .map(([menuItemId, quantity]) => ({ menuItemId, quantity, item: itemsById[menuItemId] }))
        .filter((line) => line.item),
    [cart, itemsById]
  );

  const cartCount = cartLines.reduce((total, line) => total + line.quantity, 0);
  const cartTotal = sumMoney(cartLines.map((line) => multiplyMoney(line.item.price, line.quantity)));

  function setQuantity(itemId, quantity) {
    setCart((prev) => ({ ...prev, [itemId]: Math.max(0, quantity) }));
  }

  function handleCheckout() {
    navigate('../checkout', {
      relative: 'path',
      state: {
        paymentMethod,
        cart: cartLines.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity, name: line.item.name, price: line.item.price })),
      },
    });
  }

  const loading = menu === null;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{menu?.outlet?.name ?? 'Menu'}</h1>
      <p className={styles.subtitle}>Browse the menu, build your order, and pay right here — no app, no account.</p>

      <Card
        state={loading ? 'loading' : error ? 'error' : categories.length === 0 ? 'empty' : 'success'}
        errorMessage={error}
        emptyMessage="Nothing is available to order right now."
      >
        {categories.map(([category, items]) => (
          <section key={category}>
            <h2 className={styles.category}>{category}</h2>
            {items.map((item) => (
              <div key={item.id} className={styles.itemRow}>
                <div className={styles.itemInfo}>
                  <span className={styles.itemName}>{item.name}</span>
                  <Money amount={item.price} currencyCode="NGN" />
                </div>
                <div className={styles.quantityControls}>
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    aria-label={`Remove one ${item.name}`}
                    disabled={!cart[item.id]}
                    onClick={() => setQuantity(item.id, (cart[item.id] ?? 0) - 1)}
                  >
                    −
                  </Button>
                  <span className={styles.quantityValue}>{cart[item.id] ?? 0}</span>
                  <Button type="button" size="compact" aria-label={`Add one ${item.name}`} onClick={() => setQuantity(item.id, (cart[item.id] ?? 0) + 1)}>
                    +
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </Card>

      {cartCount > 0 && (
        <div className={styles.cartBar}>
          <div className={styles.cartSummaryRow}>
            <span>
              {cartCount} item{cartCount === 1 ? '' : 's'}
            </span>
            <Money amount={cartTotal} currencyCode="NGN" />
          </div>

          <div className={formStyles.field}>
            <span className={formStyles.label}>How would you like to pay?</span>
            <div className={formStyles.radioGroup} role="radiogroup" aria-label="Payment method">
              <label className={`${formStyles.radioOption} ${paymentMethod === 'card' ? formStyles.radioOptionSelected : ''}`.trim()}>
                <input type="radio" name="payment_method" value="card" checked={paymentMethod === 'card'} onChange={() => setPaymentMethod('card')} />
                Card
              </label>
              <label className={`${formStyles.radioOption} ${paymentMethod === 'room_charge' ? formStyles.radioOptionSelected : ''}`.trim()}>
                <input
                  type="radio"
                  name="payment_method"
                  value="room_charge"
                  checked={paymentMethod === 'room_charge'}
                  onChange={() => setPaymentMethod('room_charge')}
                />
                Charge to my room
              </label>
            </div>
          </div>

          <Button type="button" onClick={handleCheckout}>
            Proceed to checkout
          </Button>
        </div>
      )}
    </div>
  );
}
