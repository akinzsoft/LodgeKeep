import styles from './Skeleton.module.css';

/**
 * Skeleton — DESIGN_SYSTEM.md §2's loading state, as a reusable primitive:
 * "skeleton placeholders matching the shape of the content (grey blocks at
 * the real dimensions), never a spinner over stale numbers."
 *
 * A shape, not a layout: `Card`, `KPICard`, and `DataTable` each compose
 * their own loading state from one or more of these, sized to match what
 * they show once real data arrives — this component only knows how to be
 * "a placeholder block", never what it is a placeholder for.
 *
 * @param {'text'|'block'|'circle'} [variant]
 * @param {string|number} [width]   Any valid CSS width — a percentage for
 *   text lines that should vary, a fixed px for a KPI numeral's known size.
 * @param {string|number} [height]
 */
export function Skeleton({ variant = 'block', width, height, className = '', ...rest }) {
  const style = {
    width: width ?? (variant === 'circle' ? height ?? '2.5rem' : '100%'),
    height: height ?? (variant === 'text' ? '1em' : '2.5rem'),
  };
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={`${styles.skeleton} ${styles[variant]} ${className}`.trim()}
      style={style}
      {...rest}
    />
  );
}
