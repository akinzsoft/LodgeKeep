import { expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** The approver list and token a screen test's `approvalsApi` mock returns. */
export const TEST_APPROVERS = [{ id: '7', name: 'Grace Manager', hasPin: true }];
export const TEST_APPROVAL_TOKEN = 'approval-token-1';

/**
 * Completes the open ManagerApprovalDialog the way a manager would: the only
 * manager with a PIN is already chosen, so type the PIN and a reason, then
 * press `confirmLabel`. Returns the dialog element.
 */
export async function approveInDialog({ reason, confirmLabel, pin = '482915' }) {
  const dialog = await screen.findByRole('dialog');
  const pinField = await within(dialog).findByLabelText(/PIN/);
  expect(within(dialog).getByRole('button', { name: confirmLabel })).toBeDisabled();
  await userEvent.type(pinField, pin);
  await userEvent.type(within(dialog).getByLabelText('Reason'), reason);
  await userEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  return dialog;
}
