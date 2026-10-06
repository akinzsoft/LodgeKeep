import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManagerApprovalDialog } from '../ManagerApprovalDialog.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ listApprovers: vi.fn(), requestApproval: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, approvalsApi: mocks };
});

const GRACE = { id: '7', name: 'Grace Manager', hasPin: true };
const TOM = { id: '8', name: 'Tom Deputy', hasPin: true };
const NOPIN = { id: '9', name: 'Ola New', hasPin: false };

function renderDialog(props = {}) {
  const onApproved = vi.fn();
  const onCancel = vi.fn();
  render(
    <ManagerApprovalDialog action="pos.void_settlement" targetId="55" title="Void this payment?" consequence="The sale is reversed." confirmLabel="Void" onApproved={onApproved} onCancel={onCancel} {...props} />
  );
  return { onApproved, onCancel, dialog: screen.getByRole('dialog', { name: 'Void this payment?' }) };
}

describe('<ManagerApprovalDialog>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('asks for a manager, their PIN and a reason, then hands back the approval token with the reason', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE, TOM, NOPIN]);
    mocks.requestApproval.mockResolvedValue({ token: 'tok-1' });
    const { onApproved, dialog } = renderDialog();

    expect(within(dialog).getByText('A manager must approve this with their PIN.')).toBeInTheDocument();
    const manager = await within(dialog).findByLabelText('Manager');
    expect(mocks.listApprovers).toHaveBeenCalledWith('pos.void_settlement');
    expect(within(manager).getByRole('option', { name: 'Ola New (no PIN set)' })).toBeDisabled();
    const approve = within(dialog).getByRole('button', { name: 'Void' });
    expect(approve).toBeDisabled();

    await userEvent.selectOptions(manager, '8');
    await userEvent.type(within(dialog).getByLabelText(/PIN/), '48a29b15'); // letters are dropped
    expect(within(dialog).getByLabelText(/PIN/)).toHaveValue('482915');
    expect(within(dialog).getByLabelText(/PIN/)).toHaveAttribute('type', 'password');
    expect(approve).toBeDisabled(); // still no reason
    await userEvent.type(within(dialog).getByLabelText('Reason'), '  Rung up twice ');
    await userEvent.click(approve);

    expect(mocks.requestApproval).toHaveBeenCalledWith({ action: 'pos.void_settlement', approverUserId: '8', pin: '482915', reason: 'Rung up twice', targetId: '55' });
    expect(onApproved).toHaveBeenCalledWith('tok-1', 'Rung up twice');
  });

  it('picks the only manager with a PIN by itself, and still needs all six PIN digits', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE, NOPIN]);
    const { dialog } = renderDialog();
    expect(await within(dialog).findByLabelText('Manager')).toHaveValue('7');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Rung up twice');
    expect(within(dialog).getByRole('button', { name: 'Void' })).toBeDisabled(); // no PIN
    await userEvent.type(within(dialog).getByLabelText(/PIN/), '48291');
    expect(within(dialog).getByRole('button', { name: 'Void' })).toBeDisabled(); // five digits
    await userEvent.type(within(dialog).getByLabelText(/PIN/), '5');
    expect(within(dialog).getByRole('button', { name: 'Void' })).toBeEnabled();
  });

  it('says a wrong PIN plainly with the tries left, clears it, and lets the manager try again', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    mocks.requestApproval
      .mockRejectedValueOnce(new ApiError({ code: 'VALIDATION_APPROVAL_PIN_INCORRECT', message: 'That PIN is not correct.', status: 422, details: { attemptsLeft: 3 } }))
      .mockResolvedValueOnce({ token: 'tok-2' });
    const { onApproved, dialog } = renderDialog();
    await userEvent.type(await within(dialog).findByLabelText(/PIN/), '000001');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Wrong item');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That PIN is not correct. 3 tries left before it locks.');
    expect(within(dialog).getByLabelText(/PIN/)).toHaveValue('');
    expect(onApproved).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/PIN/), '482915');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));
    expect(onApproved).toHaveBeenCalledWith('tok-2', 'Wrong item');
  });

  it('shows the server message for a locked PIN', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    mocks.requestApproval.mockRejectedValue(new ApiError({ code: 'LOCKED_APPROVAL_PIN', message: 'Too many wrong PINs. This manager cannot approve for 15 minutes.', status: 423 }));
    const { onApproved, dialog } = renderDialog();
    await userEvent.type(await within(dialog).findByLabelText(/PIN/), '482915');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too many wrong PINs');
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('explains when nobody here has set a PIN, and offers no way to approve', async () => {
    mocks.listApprovers.mockResolvedValue([NOPIN]);
    const { dialog } = renderDialog();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/My Profile → Approval PIN/);
    expect(within(dialog).queryByLabelText(/PIN/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Void' })).toBeDisabled();
  });

  it('retries loading the managers after a failure', async () => {
    mocks.listApprovers.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'Server unavailable.', status: 500 })).mockResolvedValueOnce([GRACE]);
    const { dialog } = renderDialog();
    expect(await within(dialog).findByText('Server unavailable.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByLabelText('Manager')).toHaveValue('7');
  });

  it('cancels on the button and on Escape, without asking the server', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    const { onCancel, dialog } = renderDialog();
    await within(dialog).findByLabelText('Manager');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it('cannot be cancelled while the PIN is being checked, so the action never runs behind a closed dialog', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    let answer;
    mocks.requestApproval.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { onApproved, onCancel, dialog } = renderDialog();
    await userEvent.type(await within(dialog).findByLabelText(/PIN/), '482915');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));

    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    answer({ token: 'tok-3' });
    await vi.waitFor(() => expect(onApproved).toHaveBeenCalledWith('tok-3', 'x'));
  });

  it('ignores an approval that arrives after the dialog was closed', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    let answer;
    mocks.requestApproval.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const onApproved = vi.fn();
    const { unmount } = render(<ManagerApprovalDialog action="pos.void_settlement" targetId="55" title="Void?" consequence="x" confirmLabel="Void" onApproved={onApproved} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.type(await within(dialog).findByLabelText(/PIN/), '482915');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));
    unmount();
    answer({ token: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('puts the cursor in the PIN field once the only manager is chosen, and a backdrop tap closes nothing', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    const { onCancel, dialog } = renderDialog();
    const pinField = await within(dialog).findByLabelText(/PIN/);
    await vi.waitFor(() => expect(pinField).toHaveFocus());
    await userEvent.click(dialog.parentElement); // the backdrop
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('is disabled while offline', async () => {
    mocks.listApprovers.mockResolvedValue([GRACE]);
    const { dialog } = renderDialog({ isOffline: true });
    await userEvent.type(await within(dialog).findByLabelText(/PIN/), '482915');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'x');
    expect(within(dialog).getByRole('button', { name: 'Void' })).toBeDisabled();
    expect(within(dialog).getByText(/offline/)).toBeInTheDocument();
  });
});
