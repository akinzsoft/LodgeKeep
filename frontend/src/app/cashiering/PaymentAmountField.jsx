import { Money } from '../../shared/format/money.jsx';
import { paymentAmountProblem, depositPortion } from './paymentAmount.js';

/**
 * The editable payment Amount, with the credit it will leave. `styles` is the host screen's own form stylesheet (as
 * `TerminalPaymentFields` takes). A text input with a decimal keypad, not `type="number"`, which hides unparsable text.
 */
export function PaymentAmountField({ styles, value, onChange, balance, currency, disabled }) {
  const problem = value.trim() ? paymentAmountProblem(value) : null;
  const deposit = depositPortion(value, balance);
  return (
    <label className={styles.field}>
      <span className={styles.label}>Amount</span>
      <input
        className={styles.input}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder="0.00"
        aria-invalid={problem ? 'true' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem && (
        <span role="alert" className={styles.fieldError}>
          {problem}
        </span>
      )}
      {deposit && (
        <span className={styles.disabledNotice}>
          <Money amount={deposit} currencyCode={currency} /> above what is owed will be kept as a credit (deposit) on the folio.
        </span>
      )}
    </label>
  );
}
