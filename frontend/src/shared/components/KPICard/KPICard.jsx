import { Card } from '../Card/Card.jsx';
import { Skeleton } from '../Skeleton/Skeleton.jsx';
import { IconBadge } from '../IconBadge/IconBadge.jsx';
import styles from './KPICard.module.css';

/**
 * KPICard — DESIGN_SYSTEM.md §1's `--text-kpi` numeral style, and §2's
 * sharpest example of why loading must be a skeleton rather than stale data:
 * "A KPI card showing yesterday's revenue while today's loads is worse than
 * showing nothing." A KPICard in `state="loading"` therefore NEVER renders
 * `value` — there is no code path that can show a stale number while loading,
 * because the loading branch doesn't read `value` at all.
 *
 * A thin composition over Card + Skeleton + IconBadge, not a fourth styling
 * system — DESIGN_SYSTEM.md §1: "Cards are the default container for
 * everything ... KPIs" — this is that container, specialised.
 *
 * @param {string} label
 * @param {string|number} [value]      Absent/ignored while state="loading" — see above.
 * @param {'booking'|'rooms'|'guest'|'money'} [domain]
 * @param {import('react').ReactNode} [icon]
 * @param {'loading'|'empty'|'error'|'success'} [state]
 * @param {string} [emptyMessage]
 * @param {string} [errorMessage]
 */
export function KPICard({ label, value, domain, icon, state = 'success', emptyMessage, errorMessage, className = '' }) {
  // 'loading' gets a KPI-specific treatment (label and icon stay visible,
  // only the numeral is a skeleton) rather than Card's generic three-line
  // skeleton — so Card is told 'success' for that case, and this component's
  // own JSX below decides what to render for value. 'empty'/'error' still
  // delegate fully to Card's generic treatment; nothing KPI-specific is
  // needed for those.
  const cardState = state === 'loading' ? 'success' : state;

  return (
    <Card
      className={`${styles.kpiCard} ${className}`.trim()}
      state={cardState}
      emptyMessage={emptyMessage}
      errorMessage={errorMessage}
    >
      <div className={styles.row}>
        {domain && <IconBadge domain={domain}>{icon}</IconBadge>}
        <div>
          <p className={styles.label}>{label}</p>
          {state === 'loading' ? (
            <Skeleton variant="text" width="5rem" height="1.8rem" data-testid="kpi-loading" />
          ) : (
            <p className={`${styles.value} tabular-nums`}>{value}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
