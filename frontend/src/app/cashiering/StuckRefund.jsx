import { cashieringApi, ApiError } from '../../shared/api/index.js';
import { StatusPill } from '../../shared/components/index.js';
import { ManagerApprovalDialog } from '../approvals/ManagerApprovalDialog.jsx';
import formStyles from './CashieringForm.module.css';

const RESULT_TEXT = {
  pending: 'Paystack says it is still processing it.',
  unreachable: 'Paystack could not be reached.',
  ambiguous: "Paystack's answer was unclear.",
  not_found: 'Paystack has no record of it yet.',
};

/** What reconciliation last learned about a refund that is still waiting on Paystack, in plain words. */
export function stuckRefundText(reconciliation) {
  if (!reconciliation) return 'Waiting on Paystack.';
  const checks = reconciliation.attempts > 0 ? `Checked ${reconciliation.attempts} time${reconciliation.attempts === 1 ? '' : 's'}. ` : 'Not checked yet. ';
  const last = reconciliation.lastResult ? (RESULT_TEXT[reconciliation.lastResult] ?? '') : '';
  return `${checks}${last}`.trim();
}

/** A refund the guest has not been repaid for yet: a pill, and what reconciliation knows. Shown on the payment row. */
export function StuckRefundNote({ reconciliation }) {
  return (
    <div>
      <StatusPill tone="warning" label="Refund waiting on Paystack" />
      <p className={formStyles.hint}>{stuckRefundText(reconciliation)}</p>
      {reconciliation?.canClear && <p className={formStyles.hint}>Reconciliation could not confirm it. A manager can clear it.</p>}
    </div>
  );
}

/**
 * "Clear stuck refund": a manager's PIN, a reason, then the request. The server refuses unless reconciliation has
 * checked Paystack enough times without an answer, and asks Paystack once more before clearing — a refund that turns
 * out to be processed is applied instead.
 */
export function ClearStuckRefundDialog({ refundPaymentId, amountText, isOffline = false, onDone, onError, onCancel }) {
  async function approved(approval, reason) {
    try {
      const result = await cashieringApi.clearStuckRefund(refundPaymentId, { reason, approval });
      onDone(result);
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'Could not clear this refund.');
    }
  }
  return (
    <ManagerApprovalDialog
      action="cashiering.clear_stuck_refund"
      targetId={refundPaymentId}
      title="Clear stuck refund"
      consequence={`Paystack never confirmed the refund of ${amountText}. Clearing it cancels the refund on our side so the amount can be refunded another way. We ask Paystack once more first; if it did refund, the refund is recorded instead.`}
      confirmLabel="Clear refund"
      isOffline={isOffline}
      onApproved={approved}
      onCancel={onCancel}
    />
  );
}
