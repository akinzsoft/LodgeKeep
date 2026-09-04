import lodgekeepIcon from '../../assets/brand/lodgekeep-icon.png';
import styles from './Footer.module.css';

/**
 * Footer — a "Powered by LodgeKeep" credit strip along the bottom of the
 * app shell. LodgeKeep's own platform mark, same as `Sidebar`'s brand row —
 * never the tenant's own branding (that's `properties.logo_url`, a separate
 * per-property concept with no read endpoint yet).
 *
 * Presentational only, no props: there is nothing here that varies by
 * caller, unlike every other shell piece.
 */
export function Footer() {
  return (
    <footer className={styles.footer}>
      <img src={lodgekeepIcon} alt="" className={styles.icon} />
      <span className={styles.text}>Powered by LodgeKeep</span>
    </footer>
  );
}
