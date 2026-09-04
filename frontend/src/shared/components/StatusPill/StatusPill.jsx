import styles from './StatusPill.module.css';

/**
 * StatusPill — DESIGN_SYSTEM.md §1's system-wide status vocabulary: "Status
 * is always rendered as a filled pill — background --state-*-bg, text
 * --state-*, never plain coloured text on white, which fails contrast at
 * small sizes." TESTING.md FE-4: "carries a text label, not colour alone."
 *
 * `tone` is the five-value semantic vocabulary DESIGN_SYSTEM.md §1's table
 * maps every domain's status words onto (success/warning/danger/info/neutral)
 * — this component only knows the five tones, never a domain-specific word
 * like "dirty" or "in-house". Each feature module maps its own status
 * strings to a tone; that mapping is written down where housekeeping/rooms/
 * reservations own it, not invented here ahead of those modules
 * (CLAUDE.md's "building ahead of phase" rule, same reasoning `rbac.js`
 * applies on the backend).
 *
 * `label` is required, never optional and never derived from `tone` — a
 * pill with no caller-supplied text would be exactly the "colour alone"
 * FE-4 exists to catch.
 *
 * @param {'success'|'warning'|'danger'|'info'|'neutral'} tone
 * @param {string} label
 */
export function StatusPill({ tone, label, className = '' }) {
  if (!label) {
    throw new Error('StatusPill requires a label — a pill cannot carry meaning by colour alone (TESTING.md FE-4).');
  }
  return <span className={`${styles.pill} ${styles[tone]} ${className}`.trim()}>{label}</span>;
}
