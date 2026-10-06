/**
 * The two optional fields of a "Card (terminal)" payment: which of the hotel's recorded terminal accounts it was taken on
 * (so reconciliation can be matched against that account's own settlement report) and the terminal's own reference.
 * Recording only: the physical terminal does the charge. `styles` is the host screen's form stylesheet (field/label/select/input).
 */
export function TerminalPaymentFields({ accounts, accountId, reference, onAccountChange, onReferenceChange, styles }) {
  return (
    <>
      <label className={styles.field}>
        <span className={styles.label}>Terminal account (optional)</span>
        <select className={styles.select ?? styles.input} value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
          <option value="">Not recorded</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {`${account.name ?? 'Account'} ····${account.last4}`}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Terminal reference (optional)</span>
        <input className={styles.input} value={reference} maxLength={60} placeholder="Receipt / RRN from the terminal" onChange={(event) => onReferenceChange(event.target.value)} />
      </label>
    </>
  );
}
