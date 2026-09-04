import styles from './IconBadge.module.css';

/**
 * IconBadge — DESIGN_SYSTEM.md §1: "filled rounded-square in the domain
 * tint, icon in the domain accent. Colour by domain, reused across every
 * screen."
 *
 * `domain` selects the colour pairing only — this component has no opinion
 * on which icon it holds. No icon library is bundled (none is named in any
 * spec, and picking one is a real product decision this file shouldn't make
 * silently); the caller passes whatever icon element it already has — an SVG,
 * a font-icon span, or a future icon library's component — as `children`.
 *
 * @param {'booking'|'rooms'|'guest'|'money'} domain
 */
export function IconBadge({ domain, children, className = '' }) {
  return (
    <span className={`${styles.badge} ${styles[domain]} ${className}`.trim()} aria-hidden="true">
      {children}
    </span>
  );
}
