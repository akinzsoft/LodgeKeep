import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpenseCategoriesCard } from '../ExpenseCategoriesCard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({
  createExpenseCategory: vi.fn(),
  updateExpenseCategory: vi.fn(),
  archiveExpenseCategory: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    expensesApi: {
      createExpenseCategory: mocks.createExpenseCategory,
      updateExpenseCategory: mocks.updateExpenseCategory,
      archiveExpenseCategory: mocks.archiveExpenseCategory,
    },
  };
});

function category(overrides) {
  return { id: '1', name: 'Utilities', sort_order: 0, item_count: 0, ...overrides };
}

describe('ExpenseCategoriesCard', () => {
  const onChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a category', async () => {
    mocks.createExpenseCategory.mockResolvedValue(category());
    render(<ExpenseCategoriesCard categories={[]} onChanged={onChanged} />);

    await userEvent.type(screen.getByLabelText('Category name'), 'Utilities');
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));

    expect(mocks.createExpenseCategory).toHaveBeenCalledWith({ name: 'Utilities', sortOrder: undefined });
    expect(onChanged).toHaveBeenCalled();
  });

  it('renames a category with no cascade warning (live FK, unlike stock\'s copied-name categories)', async () => {
    render(<ExpenseCategoriesCard categories={[category()]} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Rename category');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Maintenance');
    await userEvent.click(screen.getByRole('button', { name: 'Save category' }));

    expect(mocks.updateExpenseCategory).toHaveBeenCalledWith('1', { name: 'Maintenance', sortOrder: 0 });
  });

  it('archives a category via the confirm dialog', async () => {
    render(<ExpenseCategoriesCard categories={[category()]} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText(/will no longer be offered/i)).toBeInTheDocument();
    // Two "Archive" buttons now exist: the row action and the dialog's own confirm button.
    await userEvent.click(screen.getAllByRole('button', { name: 'Archive' })[1]);

    expect(mocks.archiveExpenseCategory).toHaveBeenCalledWith('1');
  });

  it('surfaces the real in-use 409 message when archiving fails', async () => {
    mocks.archiveExpenseCategory.mockRejectedValue(
      new ApiError({ code: 'CONFLICT_EXPENSE_CATEGORY_IN_USE', message: '"Utilities" is still used by 1 expense — move them to another category first.' })
    );
    render(<ExpenseCategoriesCard categories={[category()]} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialogConfirm = screen.getAllByRole('button', { name: 'Archive' })[1];
    await userEvent.click(dialogConfirm);

    expect(await screen.findByRole('alert')).toHaveTextContent(/still used by 1 expense/i);
  });
});
