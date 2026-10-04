import { Money } from '../../shared/format/money.jsx';
import styles from './Supermarket.module.css';

const TINTS = [styles.tint0, styles.tint1, styles.tint2, styles.tint3, styles.tint4];

/** Two letters from the product's name, for a tile with no photo ("Mama Gold Rice 5kg" → "MG"). */
export function productInitials(name) {
  const words = String(name ?? '').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word[0] ?? ''));
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
}

/** The same category always gets the same tint, so a shelf reads as one colour. */
function tintFor(category) {
  let hash = 0;
  for (const char of String(category ?? '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

/**
 * One product on the till: the whole card is one button (no nested control),
 * like the POS Register's menu tile. A photo when the product has one, else
 * its initials on a category tint; the name is cut to two lines.
 */
export function ProductTile({ item, quantityInCart, currency, disabled, onAdd }) {
  const soldOut = item.is_available === false;
  return (
    <button
      type="button"
      className={`${styles.tile} ${quantityInCart > 0 ? styles.tileInCart : ''}`}
      aria-label={`Add ${item.name}`}
      disabled={disabled || soldOut}
      onClick={() => onAdd(item)}
    >
      {item.image_url ? (
        <img className={styles.tileImage} src={item.image_url} alt="" loading="lazy" />
      ) : (
        <span className={`${styles.tileThumb} ${tintFor(item.category)}`} aria-hidden="true">
          {productInitials(item.name)}
        </span>
      )}
      <span className={styles.tileName}>{item.name}</span>
      <span className={styles.tileFooter}>
        <span className={styles.tilePrice}><Money amount={item.price} currencyCode={currency} /></span>
        {soldOut && <span className={styles.soldOut}>Sold out</span>}
        {!soldOut && quantityInCart > 0 && <span className={styles.inCartBadge}>× {quantityInCart}</span>}
      </span>
    </button>
  );
}
