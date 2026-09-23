import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { groupStockItemsByCategory, sortStockItemsByCategory, StockItemOptions } from '../stockItemOptions.jsx';

const ITEMS = [
  { id: '1', name: 'Vodka', unit: 'ml', category: 'Spirits' },
  { id: '2', name: 'Ice', unit: 'kg', category: null },
  { id: '3', name: 'Beer', unit: 'bottle', category: 'Beers' },
  { id: '4', name: 'Gin', unit: 'ml', category: 'Spirits' },
  { id: '5', name: 'Lime', unit: 'each', category: '   ' },
];

describe('groupStockItemsByCategory / sortStockItemsByCategory', () => {
  it('groups alphabetically with Uncategorized last, items by name, blank categories counting as none', () => {
    const groups = groupStockItemsByCategory(ITEMS);
    expect(groups.map((g) => g.label)).toEqual(['Beers', 'Spirits', 'Uncategorized']);
    expect(groups[1].items.map((i) => i.name)).toEqual(['Gin', 'Vodka']);
    expect(groups[2].items.map((i) => i.name)).toEqual(['Ice', 'Lime']);
  });

  it('flattens in the same order, and copes with no items', () => {
    expect(sortStockItemsByCategory(ITEMS).map((i) => i.name)).toEqual(['Beer', 'Gin', 'Vodka', 'Ice', 'Lime']);
    expect(groupStockItemsByCategory(null)).toEqual([]);
    expect(sortStockItemsByCategory(undefined)).toEqual([]);
  });
});

describe('<StockItemOptions>', () => {
  it('renders one optgroup per category with "Name (unit)" options, so a picker shows the category', () => {
    render(
      <select aria-label="Stock item">
        <option value="">Select</option>
        <StockItemOptions items={ITEMS} />
      </select>
    );
    const select = screen.getByLabelText('Stock item');
    const spirits = within(select).getByRole('group', { name: 'Spirits' });
    expect(within(spirits).getByRole('option', { name: 'Gin (ml)' })).toHaveValue('4');
    expect(within(select).getByRole('group', { name: 'Uncategorized' })).toBeInTheDocument();
  });
});
