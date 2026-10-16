import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscountDialog } from '../DiscountDialog.jsx';
import { ApiError } from '../../../shared/api/index.js';
import { approveInDialog, TEST_APPROVERS, TEST_APPROVAL_TOKEN } from '../../approvals/__tests__/approveInDialog.js';

const discountMocks = vi.hoisted(() => ({ listReasons: vi.fn(), approveDiscount: vi.fn() }));
const approvalMocks = vi.hoisted(() => ({ listApprovers: vi.fn(), requestApproval: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, discountsApi: discountMocks, approvalsApi: approvalMocks };
});

const REASONS = [
  { id: '1', name: 'Promotion', kind: 'discount' },
  { id: '2', name: 'Staff meal', kind: 'comp' },
  { id: '3', name: "Manager's gift", kind: 'both' },
];
const ACTIVE = { id: '9', kind: 'discount', status: 'active', approvalRequired: false, amount: '5.00' };
const LINES = [{ id: '11', label: 'Beer' }, { id: '12', label: 'Snack' }];

function setup(overrides = {}) {
  const props = { create: vi.fn().mockResolvedValue(ACTIVE), onDone: vi.fn(), onPending: vi.fn(), onCancel: vi.fn(), lines: LINES, ...overrides };
  render(<DiscountDialog {...props} />);
  return props;
}

describe('<DiscountDialog>', () => {
  beforeEach(() => {
    Object.values(discountMocks).forEach((fn) => fn.mockReset());
    discountMocks.listReasons.mockResolvedValue(REASONS);
    approvalMocks.listApprovers.mockResolvedValue(TEST_APPROVERS);
    approvalMocks.requestApproval.mockResolvedValue({ token: TEST_APPROVAL_TOKEN });
  });

  it('asks for the type, the value and the reason, and sends only those', async () => {
    const props = setup();
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Apply discount' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Percent off'), '10');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    await userEvent.click(submit);

    expect(props.create).toHaveBeenCalledWith({ scope: 'order', kind: 'discount', type: 'percent', value: '10', reasonId: '1', lineId: undefined });
    await waitFor(() => expect(props.onDone).toHaveBeenCalledWith(expect.objectContaining({ id: '9', reason_name: 'Promotion' })));
  });

  it('refuses a value the server would refuse before asking', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    for (const bad of ['-5', '1e2', '1.005', 'abc', '0']) {
      const field = within(dialog).getByLabelText('Percent off');
      await userEvent.clear(field);
      await userEvent.type(field, bad);
      expect(within(dialog).getByRole('button', { name: 'Apply discount' })).toBeDisabled();
    }
  });

  it('switches to an amount, and targets a line when one is chosen', async () => {
    const props = setup({ initialLineId: '12' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Applies to')).toHaveValue('line:12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Amount' }));
    await userEvent.type(within(dialog).getByLabelText('Amount off'), '2.50');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply discount' }));
    expect(props.create).toHaveBeenCalledWith({ scope: 'line', kind: 'discount', type: 'fixed', value: '2.50', reasonId: '3', lineId: '12' });
  });

  it('a comp hides the value, offers only comp reasons and always goes to a manager', async () => {
    const pending = { id: '10', kind: 'comp', status: 'pending_approval', approvalRequired: true, approvalAction: 'pos.discount_approval' };
    const props = setup({ create: vi.fn().mockResolvedValue(pending) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Comp' }));
    expect(within(dialog).queryByLabelText('Percent off')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: 'Promotion' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'Staff meal' })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: "Manager's gift" })).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(props.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'comp', type: 'percent', value: '100' }));
    expect(props.onDone).not.toHaveBeenCalled();
    expect(await screen.findByText('A manager must approve this with their PIN.')).toBeInTheDocument();
  });

  it('approving applies the discount; cancelling the approval leaves it pending', async () => {
    const pending = { id: '10', kind: 'discount', status: 'pending_approval', approvalRequired: true, approvalAction: 'pos.discount_approval' };
    discountMocks.approveDiscount.mockResolvedValue({ status: 'active' });
    const props = setup({ create: vi.fn().mockResolvedValue(pending) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Percent off'), '30');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply discount' }));
    await approveInDialog({ reason: 'ok', confirmLabel: 'Approve' });
    expect(approvalMocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'pos.discount_approval', targetId: '10' }));
    await waitFor(() => expect(props.onDone).toHaveBeenCalledWith(expect.objectContaining({ id: '10', status: 'active' })));
  });

  it('cancelling the manager step reports the request as still pending', async () => {
    const pending = { id: '10', kind: 'discount', status: 'pending_approval', approvalRequired: true, approvalAction: 'pos.discount_approval' };
    const props = setup({ create: vi.fn().mockResolvedValue(pending) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Percent off'), '30');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply discount' }));
    await userEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Cancel' }));
    expect(props.onPending).toHaveBeenCalledWith(expect.objectContaining({ id: '10' }));
    expect(props.onCancel).toHaveBeenCalled();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("shows the server's message when the request is refused", async () => {
    setup({ create: vi.fn().mockRejectedValue(new ApiError({ code: 'BUSINESS_RULE_NOTHING_TO_DISCOUNT', message: 'There is nothing to discount here.', status: 422 })) });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Percent off'), '10');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply discount' }));
    expect(await within(dialog).findByText('There is nothing to discount here.')).toBeInTheDocument();
  });

  it('cannot submit while offline', async () => {
    setup({ isOffline: true });
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Percent off'), '10');
    await userEvent.selectOptions(await within(dialog).findByLabelText('Reason'), '1');
    expect(within(dialog).getByRole('button', { name: 'Apply discount' })).toBeDisabled();
    expect(within(dialog).getByText(/offline/)).toBeInTheDocument();
  });
});
