import { Skeleton } from '../Skeleton/Skeleton.jsx';
import styles from './Card.module.css';

/**
 * Card — DESIGN_SYSTEM.md §1: "the default container for everything — KPIs,
 * charts, tables, forms." `--surface-card` background, `--radius-lg`,
 * `--shadow-card`, `--space-5` padding on desktop / `--space-4` on mobile.
 *
 * TESTING.md FE-1 requires shared components to render loading/empty/error —
 * a `state` prop is how Card carries that, since it's the container every
 * other data-bearing component (including KPICard and DataTable) sits
 * inside. `success` (the default) just renders `children` — Card has no
 * opinion on what a "successful" card looks like beyond that.
 *
 * @param {'loading'|'empty'|'error'|'success'} [state]
 * @param {string} [title]
 * @param {string} [emptyMessage]    DESIGN_SYSTEM.md §2: "explain what belongs here and give the action that fills it" — the action itself is emptyAction, since only the caller knows what it is.
 * @param {import('react').ReactNode} [emptyAction]
 * @param {string} [errorMessage]    DESIGN_SYSTEM.md §2: "say what happened and what to do, in one sentence, without a raw exception string."
 */
export function Card({ state = 'success', title, emptyMessage, emptyAction, errorMessage, children, className = '' }) {
  return (
    <section className={`${styles.card} ${className}`.trim()}>
      {title && <h2 className={styles.title}>{title}</h2>}
      {state === 'loading' && (
        <div className={styles.loading} data-testid="card-loading">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="text" width="90%" />
          <Skeleton variant="text" width="75%" />
        </div>
      )}
      {state === 'empty' && (
        <div className={styles.empty} data-testid="card-empty">
          <p className={styles.emptyMessage}>{emptyMessage}</p>
          {emptyAction}
        </div>
      )}
      {state === 'error' && (
        <div className={styles.error} role="alert" data-testid="card-error">
          <p>{errorMessage}</p>
        </div>
      )}
      {state === 'success' && children}
    </section>
  );
}
