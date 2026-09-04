import styles from './BusinessDateIndicator.module.css';

/**
 * BusinessDateIndicator — PRODUCT_REQUIREMENTS.md's App shell: "the
 * property's current business date shown persistently, because it can
 * differ from the wall-clock date after/before night audit" (ARCHITECTURE.md
 * §6: "Business date ≠ wall clock").
 *
 * `businessDate` is a plain 'YYYY-MM-DD' string, exactly as the API and
 * database carry it (DATABASE.md, `dateStrings: ['DATE']` in the backend's
 * knexfile.js) — never parsed through `new Date(businessDate)`. Doing that
 * would parse the string as UTC midnight and then render it in the browser's
 * own timezone, which can silently shift the displayed date by one day —
 * exactly the class of bug the business-date design exists to prevent, now
 * on the one screen element whose entire job is showing that date correctly.
 * This component only ever reformats the string's own digits.
 *
 * The wall-clock comparison (`isDifferentFromToday`) is computed the same
 * way, from the viewer's own local calendar date — never from a `Date`
 * parse of `businessDate`.
 *
 * @param {string} businessDate   'YYYY-MM-DD'
 * @param {Date} [now]            Injectable for tests; defaults to `new Date()`.
 */
export function BusinessDateIndicator({ businessDate, now = new Date() }) {
  const [year, month, day] = businessDate.split('-');
  const display = `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;

  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const isDifferentFromToday = businessDate !== todayLocal;

  return (
    <div className={styles.indicator} title="Property business date">
      <span className={styles.label}>Business date</span>
      <span className={styles.value}>{display}</span>
      {isDifferentFromToday && (
        <span className={styles.note} role="note">
          differs from today
        </span>
      )}
    </div>
  );
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
