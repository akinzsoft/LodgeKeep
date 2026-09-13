import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { qrOrderingApi, ApiError } from '../../shared/api/index.js';
import { loadCart, saveCart } from '../cartStorage.js';
import styles from './MenuScreen.module.css';

const MAX_QUANTITY = 99;

/**
 * MenuScreen — where a guest's scan of the printed QR code lands
 * (`QrOrderApp.jsx`). Laid out like a shop (user-requested: "design like a
 * shopping item page, add a cart in case the customer is ordering many
 * items"):
 * - item cards in a grid, with photos, filterable by category chips and a
 *   search box;
 * - "Add to cart" on each card, turning into a − / quantity / + stepper;
 * - a sticky cart bar (item count and exact total) that opens a cart sheet
 *   listing every line with its own stepper, line total, and remove, the
 *   subtotal, the payment choice, and "Proceed to checkout".
 *
 * The cart is remembered per QR token in sessionStorage (`cartStorage.js`),
 * so a long order survives a reload or a trip to checkout and back; the
 * checkout screen clears it once the order is placed. Money is summed
 * exactly (`shared/money.js`).
 *
 * `pos_menu_items` carries no currency of its own, so prices show in NGN,
 * the same convention the rest of this surface uses. Both payment methods
 * are always offered: the menu does not reveal whether the scanned code is a
 * room or table code, and the backend rejects a room charge from a table
 * code with a readable error on checkout.
 */
export function MenuScreen() {
  const { token } = useOutletContext();
  const navigate = useNavigate();

  const [menu, setMenu] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState(() => loadCart(token)); // menuItemId -> quantity
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [cartOpen, setCartOpen] = useState(false);

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

  useEffect(() => {
    saveCart(token, cart);
  }, [token, cart]);

  const items = useMemo(() => menu?.items ?? [], [menu]);
  const itemsById = useMemo(() => Object.fromEntries(items.map((item) => [String(item.id), item])), [items]);
  const categories = useMemo(() => [...new Set(items.map((item) => item.category))], [items]);

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => (!category || item.category === category) && (!needle || item.name.toLowerCase().includes(needle)));
  }, [items, category, query]);

  // Items no longer on the menu (sold out since they were added) drop out of
  // the cart itself, not just the view — otherwise a restocked item would
  // reappear with its old quantity. Only once a real menu has loaded: a failed
  // load must never wipe the guest's cart.
  useEffect(() => {
    if (!menu || error) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile the remembered cart with the freshly loaded menu
    setCart((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => itemsById[id]));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [menu, error, itemsById]);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the sheet once the last line is removed
    if (cartOpen && cartCount === 0) setCartOpen(false);
  }, [cartOpen, cartCount]);

  function setQuantity(itemId, quantity) {
    setCart((prev) => ({ ...prev, [String(itemId)]: Math.min(MAX_QUANTITY, Math.max(0, quantity)) }));
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
    <div className={styles.shop}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{menu?.outlet?.name ?? 'Menu'}</h1>
          <p className={styles.subtitle}>Order from your table or room — no app, no account.</p>
        </div>
        <button type="button" className={styles.cartIconButton} onClick={() => cartCount > 0 && setCartOpen(true)} aria-label={`Cart, ${cartCount} item${cartCount === 1 ? '' : 's'}`}>
          <CartIcon />
          {cartCount > 0 && <span className={styles.cartBadge}>{cartCount}</span>}
        </button>
      </header>

      {!loading && !error && items.length > 0 && (
        <div className={styles.filters}>
          <input
            className={styles.search}
            type="search"
            placeholder="Search the menu"
            aria-label="Search the menu"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className={styles.chips} role="toolbar" aria-label="Categories">
            <button type="button" className={`${styles.chip} ${category === '' ? styles.chipActive : ''}`.trim()} aria-pressed={category === ''} onClick={() => setCategory('')}>
              All
            </button>
            {categories.map((name) => (
              <button
                key={name}
                type="button"
                className={`${styles.chip} ${category === name ? styles.chipActive : ''}`.trim()}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <div className={styles.grid} aria-busy="true">{[0, 1, 2, 3].map((n) => <div key={n} className={`${styles.card} ${styles.skeleton}`} />)}</div>}
      {!loading && error && (
        <p role="alert" className={styles.notice}>
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && <p className={styles.notice}>Nothing is available to order right now.</p>}
      {!loading && !error && items.length > 0 && visibleItems.length === 0 && <p className={styles.notice}>No items match your search.</p>}

      {!loading && !error && visibleItems.length > 0 && (
        <ul className={styles.grid} aria-label="Menu items">
          {visibleItems.map((item) => {
            const quantity = cart[String(item.id)] ?? 0;
            return (
              <li key={item.id} className={styles.card}>
                <div className={styles.imageBox}>
                  {item.image_url ? (
                    <img className={styles.image} src={item.image_url} alt="" loading="lazy" />
                  ) : (
                    <span className={styles.imagePlaceholder} aria-hidden="true">
                      {item.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  {quantity > 0 && <span className={styles.inCart}>{quantity} in cart</span>}
                </div>
                <div className={styles.cardBody}>
                  <span className={styles.cardCategory}>{item.category}</span>
                  <h2 className={styles.cardName}>{item.name}</h2>
                  <span className={styles.cardPrice}>
                    <Money amount={item.price} currencyCode="NGN" />
                  </span>
                  {quantity === 0 ? (
                    <button type="button" className={styles.addButton} aria-label={`Add ${item.name} to cart`} onClick={() => setQuantity(item.id, 1)}>
                      Add to cart
                    </button>
                  ) : (
                    <Stepper name={item.name} quantity={quantity} onChange={(next) => setQuantity(item.id, next)} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {cartCount > 0 && !cartOpen && (
        <div className={styles.cartBar}>
          <button type="button" className={styles.cartBarButton} onClick={() => setCartOpen(true)}>
            <span className={styles.cartBarCount}>
              {cartCount} item{cartCount === 1 ? '' : 's'}
            </span>
            <span className={styles.cartBarLabel}>View cart</span>
            <span className={styles.cartBarTotal}>
              <Money amount={cartTotal} currencyCode="NGN" />
            </span>
          </button>
        </div>
      )}

      {cartOpen && (
        <CartSheet
          lines={cartLines}
          cartCount={cartCount}
          cartTotal={cartTotal}
          paymentMethod={paymentMethod}
          onPaymentMethod={setPaymentMethod}
          onQuantity={setQuantity}
          onClear={() => setCart({})}
          onClose={() => setCartOpen(false)}
          onCheckout={handleCheckout}
        />
      )}
    </div>
  );
}

function Stepper({ name, quantity, onChange }) {
  return (
    <div className={styles.stepper}>
      <button type="button" className={styles.stepperButton} aria-label={`Remove one ${name}`} onClick={() => onChange(quantity - 1)}>
        −
      </button>
      <span className={styles.stepperValue} aria-live="polite">
        {quantity}
      </span>
      <button type="button" className={styles.stepperButton} aria-label={`Add one ${name}`} disabled={quantity >= MAX_QUANTITY} onClick={() => onChange(quantity + 1)}>
        +
      </button>
    </div>
  );
}

/** The cart as a bottom sheet: every line, the subtotal, how to pay, and checkout. Escape or the backdrop closes it. */
function CartSheet({ lines, cartCount, cartTotal, paymentMethod, onPaymentMethod, onQuantity, onClear, onClose, onCheckout }) {
  const headingRef = useRef(null);
  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="qr-cart-title" onClick={(event) => event.stopPropagation()}>
        <div className={styles.sheetHeader}>
          <h2 id="qr-cart-title" ref={headingRef} tabIndex={-1} className={styles.sheetTitle}>
            Your cart · {cartCount} item{cartCount === 1 ? '' : 's'}
          </h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close cart">
            ✕
          </button>
        </div>

        <ul className={styles.lines}>
          {lines.map((line) => (
            <li key={line.menuItemId} className={styles.line}>
              <div className={styles.lineThumb}>
                {line.item.image_url ? <img src={line.item.image_url} alt="" /> : <span aria-hidden="true">{line.item.name.slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className={styles.lineInfo}>
                <span className={styles.lineName}>{line.item.name}</span>
                <span className={styles.lineUnit}>
                  <Money amount={line.item.price} currencyCode="NGN" /> each
                </span>
                <Stepper name={line.item.name} quantity={line.quantity} onChange={(next) => onQuantity(line.menuItemId, next)} />
              </div>
              <div className={styles.lineEnd}>
                <span className={styles.lineTotal}>
                  <Money amount={multiplyMoney(line.item.price, line.quantity)} currencyCode="NGN" />
                </span>
                <button type="button" className={styles.removeLink} onClick={() => onQuantity(line.menuItemId, 0)} aria-label={`Remove ${line.item.name} from cart`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className={styles.subtotal}>
          <span>Subtotal</span>
          <Money amount={cartTotal} currencyCode="NGN" />
        </div>
        <p className={styles.hint}>Any applicable tax is added when your order is placed.</p>

        <fieldset className={styles.payment}>
          <legend className={styles.paymentLegend}>How would you like to pay?</legend>
          <label className={`${styles.paymentOption} ${paymentMethod === 'card' ? styles.paymentOptionSelected : ''}`.trim()}>
            <input type="radio" name="payment_method" value="card" checked={paymentMethod === 'card'} onChange={() => onPaymentMethod('card')} />
            Card
          </label>
          <label className={`${styles.paymentOption} ${paymentMethod === 'room_charge' ? styles.paymentOptionSelected : ''}`.trim()}>
            <input type="radio" name="payment_method" value="room_charge" checked={paymentMethod === 'room_charge'} onChange={() => onPaymentMethod('room_charge')} />
            Charge to my room
          </label>
        </fieldset>

        <Button type="button" onClick={onCheckout}>
          Proceed to checkout
        </Button>
        <div className={styles.sheetActions}>
          <button type="button" className={styles.textButton} onClick={onClose}>
            Keep ordering
          </button>
          <button type="button" className={styles.textButton} onClick={onClear}>
            Empty cart
          </button>
        </div>
      </section>
    </div>
  );
}

function CartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.46 1.16h7.9a1.5 1.5 0 0 0 1.45-1.12L20 8H6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="19.5" r="1.4" fill="currentColor" />
      <circle cx="17" cy="19.5" r="1.4" fill="currentColor" />
    </svg>
  );
}
