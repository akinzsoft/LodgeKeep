import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecurringTab } from '../RecurringTab.jsx';

const mocks = vi.hoisted(() => ({
  listRecurringExpenseSchedules: vi.fn(),
  createRecurringExpenseSchedule: vi.fn(),
  pauseRecurringExpenseSchedule: vi.fn(),
  resumeRecurringExpenseSchedule: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      listRecurringExpenseSchedules: mocks.listRecurringExpenseSchedules,
      createRecurringExpenseSchedule: mocks.createRecurringExpenseSchedule,
      pauseRecurringExpenseSchedule: mocks.pauseRecurringExpenseSchedule,
      resumeRecurringExpenseSchedule: mocks.resumeRecurringExpenseSchedule,
    },
  };
});

const categories = [{ id: '1', name: 'Utilities' }];
const activeProperty = { base_currency: 'NGN', current_business_date: '2027-01-15' };

function schedule(overrides) {
  return { id: '5', description: 'Rent', payee: 'Landlord', amount: '5000.00', currency: 'NGN', frequency: 'monthly', next_due_date: '2027-02-01', last_posted_date: null, status: 'active', ...overrides };
}

describe('RecurringTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRecurringExpenseSchedules.mockResolvedValue([]);
  });

  it('shows day-of-month for monthly/quarterly/annually, day-of-week for weekly', async () => {
    render(<RecurringTab categories={categories} activeProperty={activeProperty} isOffline={false} />);
    expect(await screen.findByLabelText('Day of month')).toBeInTheDocument();
    expect(screen.queryByLabelText('Day of week')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'weekly');
    expect(screen.getByLabelText('Day of week')).toBeInTheDocument();
    expect(screen.queryByLabelText('Day of month')).not.toBeInTheDocument();
  });

  it('creates a monthly schedule', async () => {
    mocks.createRecurringExpenseSchedule.mockResolvedValue(schedule());
    render(<RecurringTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    await userEvent.selectOptions(screen.getByLabelText('Category'), '1');
    await userEvent.type(screen.getByLabelText('Description'), 'Rent');
    await userEvent.type(screen.getByLabelText(/Amount/), '5000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }));

    expect(mocks.createRecurringExpenseSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ expenseCategoryId: '1', description: 'Rent', amount: '5000', frequency: 'monthly', dayOfMonth: 1 })
    );
  });

  it('lists schedules with a status pill and toggles pause/resume', async () => {
    mocks.listRecurringExpenseSchedules.mockResolvedValue([schedule()]);
    render(<RecurringTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(mocks.pauseRecurringExpenseSchedule).toHaveBeenCalledWith('5');
  });

  it('shows Resume for a paused schedule', async () => {
    mocks.listRecurringExpenseSchedules.mockResolvedValue([schedule({ status: 'paused' })]);
    render(<RecurringTab categories={categories} activeProperty={activeProperty} isOffline={false} />);

    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeRecurringExpenseSchedule).toHaveBeenCalledWith('5');
  });

  it('disables creating while offline', () => {
    render(<RecurringTab categories={categories} activeProperty={activeProperty} isOffline />);
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.getByText(/disabled while offline/i)).toBeInTheDocument();
  });
});
