import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostPricesCard } from '../CostPricesCard.jsx';
import { ApiError } from '../../../shared/api/index.js';

const mocks = vi.hoisted(() => ({ updateMenuItem: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, posApi: { updateMenuItem: mocks.updateMenuItem } };
});

const ITEMS = [
  { id: '1', name: 'Plain snack', category: 'Food', price: '10.00', cost_price: null },
  { id: '2', name: 'Priced snack', category: 'Food', price: '20.00', cost_price: '12.00' },
  { id: '3', name: 'Bottled beer', category: 'Drinks', price: '30.00', cost_price: null },
  { id: '4', name: 'House cocktail', category: 'Drinks', price: '40.00', cost_price: null },
  { id: '5', name: 'Fresh stock', category: 'Drinks', price: '5.00', cost_price: null },
];
const KIND = { 1: 'none', 2: 'none', 3: 'stock', 4: 'compound', 5: 'stock' };
const STOCK = { 3: { purchase_cost: '4.00' }, 5: { purchase_cost: '0.00' } };

function setup(overrides = {}) {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  render(
    <CostPricesCard
      menuItems={ITEMS}
      recipeKind={(id) => KIND[id]}
      linkedStockItemFor={(id) => STOCK[id] ?? null}
      activeProperty={{ base_currency: 'NGN' }}
      onSaved={onSaved}
      {...overrides}
    />
  );
  return { onSaved };
}

const costInput = (name) => screen.getByLabelText(`Cost price for ${name}`);

describe('<CostPricesCard>', () => {
  beforeEach(() => {
    mocks.updateMenuItem.mockReset();
    mocks.updateMenuItem.mockResolvedValue({});
  });

  it('gives an input only to items with no stock recipe, and says where the others get their cost', () => {
    setup();
    expect(costInput('Plain snack')).toHaveValue('');
    expect(costInput('Priced snack')).toHaveValue('12.00');
    expect(screen.queryByLabelText('Cost price for Bottled beer')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cost price for House cocktail')).not.toBeInTheDocument();

    expect(within(screen.getByText('Bottled beer').closest('tr')).getByText('From stock')).toBeInTheDocument();
    expect(within(screen.getByText('House cocktail').closest('tr')).getByText('From its recipe')).toBeInTheDocument();
  });

  it('flags a stock-cost item whose stock has no cost yet, since its profit would look like 100%', () => {
    setup();
    expect(within(screen.getByText('Fresh stock').closest('tr')).getByText(/no cost yet, receive stock/)).toBeInTheDocument();
  });

  it('counts how many editable items already have a cost price', () => {
    setup();
    expect(screen.getByText(/1 of 2 editable items have a cost price/)).toBeInTheDocument();
  });

  it('saves only the rows that changed, as exact strings, then reloads the list', async () => {
    const { onSaved } = setup();
    await userEvent.type(costInput('Plain snack'), '6.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 cost price' }));

    expect(mocks.updateMenuItem).toHaveBeenCalledTimes(1);
    expect(mocks.updateMenuItem).toHaveBeenCalledWith('1', { cost_price: '6.5' });
    expect(await screen.findByText('Saved 1 cost price.')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('clearing a cost price sends null, un-setting it', async () => {
    setup();
    await userEvent.clear(costInput('Priced snack'));
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 cost price' }));
    expect(mocks.updateMenuItem).toHaveBeenCalledWith('2', { cost_price: null });
  });

  it('disables Save until something changes, and treats retyping the stored value as no change', async () => {
    setup();
    const save = screen.getByRole('button', { name: 'Save cost prices' });
    expect(save).toBeDisabled();
    await userEvent.clear(costInput('Priced snack'));
    await userEvent.type(costInput('Priced snack'), '12');
    expect(screen.getByRole('button', { name: 'Save cost prices' })).toBeDisabled();
  });

  it('rejects an invalid amount before saving anything, naming the item', async () => {
    setup();
    await userEvent.type(costInput('Plain snack'), '5');
    fireEvent.change(costInput('Priced snack'), { target: { value: '1.999' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save 2 cost prices' }));

    expect(mocks.updateMenuItem).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('nothing was saved');
    expect(screen.getByText(/Priced snack: Enter an amount of zero or more/)).toBeInTheDocument();
  });

  it('one failure does not stop the rest: the others save, and the failed row stays with its typed value and its reason', async () => {
    mocks.updateMenuItem.mockImplementation(async (id) => {
      if (id === '1') throw new ApiError({ code: 'FORBIDDEN', message: 'No permission.', status: 403 });
      return {};
    });
    const { onSaved } = setup();
    await userEvent.type(costInput('Plain snack'), '5');
    await userEvent.clear(costInput('Priced snack'));
    await userEvent.type(costInput('Priced snack'), '13');
    await userEvent.click(screen.getByRole('button', { name: 'Save 2 cost prices' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Saved 1; 1 could not be saved');
    expect(screen.getByText('Plain snack: No permission.')).toBeInTheDocument();
    expect(mocks.updateMenuItem).toHaveBeenCalledTimes(2);
    expect(costInput('Plain snack')).toHaveValue('5'); // Still there to fix and retry.
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save 1 cost price' })).toBeEnabled();
  });

  it('"Only items with no cost price" narrows the table to editable items still unset', async () => {
    setup();
    await userEvent.click(screen.getByLabelText(/Only items with no cost price \(1\)/));
    expect(screen.getByText('Plain snack')).toBeInTheDocument();
    expect(screen.queryByText('Priced snack')).not.toBeInTheDocument();
    expect(screen.queryByText('Bottled beer')).not.toBeInTheDocument();
  });

  it('an unsaved edit stays visible when the "only missing" filter is switched on', async () => {
    setup();
    await userEvent.clear(costInput('Priced snack'));
    await userEvent.type(costInput('Priced snack'), '15');
    await userEvent.click(screen.getByLabelText(/Only items with no cost price/));

    expect(costInput('Priced snack')).toHaveValue('15');
    expect(screen.getByRole('button', { name: 'Save 1 cost price' })).toBeEnabled();
  });

  it('text that is not an amount is rejected, never saved as "clear the cost price"', async () => {
    setup();
    await userEvent.clear(costInput('Priced snack'));
    await userEvent.type(costInput('Priced snack'), '1e');
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 cost price' }));

    expect(mocks.updateMenuItem).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('nothing was saved');
  });

  it('keeps the filter checkbox reachable even when nothing is left to show', async () => {
    setup({ menuItems: [ITEMS[1]] });
    await userEvent.click(screen.getByLabelText(/Only items with no cost price \(0\)/));
    expect(screen.getByText('Every editable item already has a cost price.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Only items with no cost price/)).toBeInTheDocument();
  });

  it('shows an empty state when the outlet has no menu items', () => {
    setup({ menuItems: [] });
    expect(screen.getByText('No menu items at this outlet yet.')).toBeInTheDocument();
  });

  it('disables every input and the save button while offline', () => {
    setup({ isOffline: true });
    expect(costInput('Plain snack')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save cost prices' })).toBeDisabled();
  });
});
