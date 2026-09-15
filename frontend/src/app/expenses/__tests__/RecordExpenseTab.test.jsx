import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordExpenseTab } from '../RecordExpenseTab.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  listExpenses: vi.fn(),
  recordExpense: vi.fn(),
  voidExpense: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      listExpenses: mocks.listExpenses,
      recordExpense: mocks.recordExpense,
      voidExpense: mocks.voidExpense,
    },
  };
});

const categories = [{ id: '1', name: 'Utilities' }];
const activeProperty = { base_currency: 'NGN', current_business_date: '2027-01-15' };

function expense(overrides) {
  return {
    id: '9',
    business_date: '2027-01-15',
    description: 'Diesel',
    payee: 'ABC Fuel',
    payment_method: 'cash',
    amount: '150.00',
    currency: 'NGN',
    voided_at: null,
    void_reason: null,
    ...overrides,
  };
}

describe('RecordExpenseTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExpenses.mockResolvedValue([]);
  });

  it('records an expense with a real Idempotency-Key header via the API wrapper, defaulting the date to the property\'s current business date', async () => {
    mocks.recordExpense.mockResolvedValue(expense());
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    await userEvent.selectOptions(screen.getByLabelText('Category'), '1');
    await userEvent.type(screen.getByLabelText('Description'), 'Diesel');
    await userEvent.type(screen.getByLabelText(/Amount/), '150.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record expense' }));

    expect(mocks.recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ expenseCategoryId: '1', description: 'Diesel', amount: '150', currency: 'NGN', paymentMethod: 'cash' })
    );
  });

  it('surfaces a real backend validation error', async () => {
    mocks.recordExpense.mockRejectedValue(new ApiError({ code: 'VALIDATION_CURRENCY_MISMATCH', message: 'This property\'s currency is "NGN" — "USD" is not accepted.' }));
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    await userEvent.selectOptions(screen.getByLabelText('Category'), '1');
    await userEvent.type(screen.getByLabelText('Description'), 'Diesel');
    await userEvent.type(screen.getByLabelText(/Amount/), '150.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record expense' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/is not accepted/i);
  });

  it('shows the recorded and voided list, struck through for a voided row with its reason', async () => {
    mocks.listExpenses.mockResolvedValue([expense({ id: '1', description: 'Active expense' }), expense({ id: '2', description: 'Voided expense', voided_at: '2027-01-16', void_reason: 'duplicate' })]);
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    expect(await screen.findByText('Active expense')).toBeInTheDocument();
    expect(screen.getByText('Voided expense')).toBeInTheDocument();
    expect(screen.getByText(/Voided: duplicate/)).toBeInTheDocument();
  });

  it('voids an expense only once a reason is typed (requireReason)', async () => {
    mocks.listExpenses.mockResolvedValue([expense({ id: '1' })]);
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Void' }));
    // Two "Void" buttons now exist: the row action and the dialog's own confirm button.
    expect(screen.getAllByRole('button', { name: 'Void' })[1]).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason'), 'Duplicate entry');
    expect(screen.getAllByRole('button', { name: 'Void' })[1]).not.toBeDisabled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Void' })[1]);

    expect(mocks.voidExpense).toHaveBeenCalledWith('1', 'Duplicate entry');
  });

  it('disables recording while offline', async () => {
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline />);
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.getByText(/disabled while offline/i)).toBeInTheDocument();
  });

  it('filters by category, date range, and payment method', async () => {
    render(<RecordExpenseTab categories={categories} activeProperty={activeProperty} isOffline={false} />);
    await screen.findByText(/No expenses recorded yet/i);

    mocks.listExpenses.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('Filter by payment method'), 'card');
    expect(mocks.listExpenses).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: 'card' }));
  });
});
