import styles from './BookingScreen.module.css';

/**
 * A reservation's confirmation number, readable. The full number is a
 * 26-character ULID (unique, but no one can read it out over the phone);
 * its last 8 characters are the random, distinguishing part, so that is
 * what shows — the full number stays in the tooltip and for screen readers,
 * and the Reservations search matches either.
 */
export function shortReference(confirmationNumber) {
  const value = String(confirmationNumber ?? '');
  return value.length > 10 ? value.slice(-8) : value;
}

export function ConfirmationRef({ value }) {
  if (!value) return '—';
  return (
    <span className={styles.reference} title={value} aria-label={`Confirmation ${value}`}>
      {shortReference(value)}
    </span>
  );
}
