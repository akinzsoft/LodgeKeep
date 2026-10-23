import { useId, useState } from 'react';
import { ConfirmDialog } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { ManagerApprovalDialog } from '../approvals/ManagerApprovalDialog.jsx';
import { REFUND_REASONS } from './refundReasons.js';
import formStyles from './POSForm.module.css';
import styles from './SalesTab.module.css';

/**
 * RefundCardSaleDialog — refunding a card sale that was already settled. Two steps, so the person at the till sees what
 * they are about to refund before anyone types a PIN:
 *
 * 1. The sale (amount, Paystack reference), a required reason from a fixed list ("Other" needs a few words), and a plain
 *    statement that a manager's PIN is needed next.
 * 2. A manager picks themselves and types their PIN (`ManagerApprovalDialog`, action `pos.refund_payment`, bound to this
 *    payment). Only then is `onApproved` called with the reason and the single-use approval token.
 *
 * The refund is always the full captured amount; there is no amount field. The server decides everything that matters.
 *
 * @param {{paymentId: string, amount: string, currency: string, providerReference: string|null, tableLabel: string|null, orderId: string}} sale
 * @param {(result: {reasonCode: string, reasonNote: string, approval: string}) => void} onApproved
 */
export function RefundCardSaleDialog({ sale, isOffline = false, onApproved, onCancel }) {
  const reasonId = useId();
  const noteId = useId();
  const [reasonCode, setReasonCode] = useState('');
  const [reasonNote, setReasonNote] = useState('');
  const [step, setStep] = useState('details');

  const needsNote = reasonCode === 'other';
  const ready = Boolean(reasonCode) && (!needsNote || reasonNote.trim().length > 0);
  const tab = sale.tableLabel ? `#${sale.orderId} · ${sale.tableLabel}` : `#${sale.orderId}`;

  if (step === 'pin') {
    return (
      <ManagerApprovalDialog
        action="pos.refund_payment"
        targetId={sale.paymentId}
        title="Manager approval for the refund"
        consequence={`This sends a full refund of ${sale.amount} ${sale.currency} to Paystack for ${tab}. The customer gets their money back and this cannot be undone.`}
        confirmLabel="Approve refund"
        isOffline={isOffline}
        onApproved={(approval) => onApproved({ reasonCode, reasonNote: reasonNote.trim(), approval })}
        onCancel={onCancel}
      />
    );
  }

  return (
    <ConfirmDialog
      title="Refund card sale"
      consequence="The whole card payment is returned to the customer through Paystack. A manager PIN is needed: a manager will enter their PIN on the next step."
      confirmLabel="Continue to manager PIN"
      confirmDisabled={!ready || isOffline}
      onConfirm={() => setStep('pin')}
      onCancel={onCancel}
    >
      <dl className={styles.refundFacts}>
        <div>
          <dt>Tab</dt>
          <dd>{tab}</dd>
        </div>
        <div>
          <dt>Amount to refund</dt>
          <dd>
            <Money amount={sale.amount} currencyCode={sale.currency} />
          </dd>
        </div>
        <div>
          <dt>Paystack reference</dt>
          <dd>{sale.providerReference ?? '—'}</dd>
        </div>
      </dl>
      <label className={formStyles.field} htmlFor={reasonId}>
        <span className={formStyles.label}>Why is this being refunded?</span>
      </label>
      <select id={reasonId} className={formStyles.select} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
        <option value="">Choose a reason</option>
        {REFUND_REASONS.map((reason) => (
          <option key={reason.code} value={reason.code}>
            {reason.label}
          </option>
        ))}
      </select>
      {reasonCode && (
        <>
          <label className={formStyles.field} htmlFor={noteId}>
            <span className={formStyles.label}>{needsNote ? 'Say why' : 'Note (optional)'}</span>
          </label>
          <input id={noteId} className={formStyles.input} value={reasonNote} maxLength={300} onChange={(event) => setReasonNote(event.target.value)} required={needsNote} />
        </>
      )}
    </ConfirmDialog>
  );
}
