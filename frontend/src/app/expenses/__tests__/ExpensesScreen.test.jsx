import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpensesScreen } from '../ExpensesScreen.jsx';

const mocks = vi.hoisted(() => ({
  listExpenseCategories: vi.fn(),
  listExpenses: vi.fn(),
  listRecurringExpenseSchedules: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      listExpenseCategories: mocks.listExpenseCategories,
      listExpenses: mocks.listExpenses,
      listRecurringExpenseSchedules: mocks.listRecurringExpenseSchedules,
    },
  };
});

const activeProperty = { base_currency: 'NGN', current_business_date: '2027-01-15' };

describe('ExpensesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExpenseCategories.mockResolvedValue([{ id: '1', name: 'Utilities', sort_order: 0, item_count: 0 }]);
    mocks.listExpenses.mockResolvedValue([]);
    mocks.listRecurringExpenseSchedules.mockResolvedValue([]);
  });

  it('defaults to the Categories tab and switches between tabs', async () => {
    render(<ExpensesScreen activeProperty={activeProperty} isOffline={false} />);
    expect(await screen.findByText('Utilities')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Record Expense' }));
    expect(await screen.findByRole('button', { name: 'Record expense' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Recurring' }));
    expect(await screen.findByRole('button', { name: 'Create schedule' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(await screen.findByRole('button', { name: 'Run reports' })).toBeInTheDocument();
  });

  it('surfaces a real category-load error without crashing the screen', async () => {
    mocks.listExpenseCategories.mockRejectedValue(new Error('boom'));
    render(<ExpensesScreen activeProperty={activeProperty} isOffline={false} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
