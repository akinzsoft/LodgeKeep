import styles from './Button.module.css';

/**
 * Button — the one control DESIGN_SYSTEM.md §1 assumes exists ("Cards ...
 * buttons ... --radius-md", `--control-h` "inputs, buttons") but never got
 * its own component: every screen that needed one was reaching for a bare
 * `<button>` with an inline style, which is exactly the "no literal values
 * outside tokens.css" rule applied to zero styling instead of a hardcoded
 * one. This is that missing piece — a thin, token-only wrapper, nothing more.
 *
 * `variant="primary"` is the one filled, high-emphasis action on a screen
 * (submit, confirm); `secondary` is a bordered lower-emphasis action;
 * `danger` is an irreversible/destructive action (DESIGN_SYSTEM.md §2's
 * warning/confirmation state almost always pairs with this); `ghost` is a
 * borderless low-emphasis action (a "Cancel" beside a primary submit).
 *
 * `--control-h-touch` (44px) is the default height, not `--control-h`
 * (40px) — DESIGN_SYSTEM.md §1: "minimum 44×44px on any screen a
 * housekeeper or front-desk agent uses on a tablet or phone ... Desktop-only
 * admin screens may use 40px." A caller on a confirmed desktop-only screen
 * opts into the smaller size with `size="compact"`; touch-safe is the
 * default because getting this wrong silently fails accessibility rather
 * than loudly failing a build.
 *
 * @param {'primary'|'secondary'|'danger'|'ghost'} [variant]
 * @param {'default'|'compact'} [size]
 * @param {boolean} [loading]      Disables the button and swaps its label for a plain "…" — no spinner component exists yet; DESIGN_SYSTEM.md §2 reserves real spinners for skeleton loading, not button-level busy state.
 * @param {'button'|'submit'} [type]
 */
export function Button({
  variant = 'primary',
  size = 'default',
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      className={`${styles.button} ${styles[variant]} ${size === 'compact' ? styles.compact : ''} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? '…' : children}
    </button>
  );
}
