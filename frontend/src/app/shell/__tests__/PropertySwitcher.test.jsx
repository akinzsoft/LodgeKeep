import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertySwitcher } from '../PropertySwitcher.jsx';

describe('<PropertySwitcher>', () => {
  it('shows only the property name, no switcher, when the tenant holds one property', () => {
    render(
      <PropertySwitcher
        activeProperty={{ id: '1', name: 'Alpha Hotels — Lagos' }}
        properties={[{ id: '1', name: 'Alpha Hotels — Lagos' }]}
        onSwitchProperty={() => {}}
      />
    );
    expect(screen.getByText('Alpha Hotels — Lagos')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('the current property is always visible even with a switcher present', () => {
    render(
      <PropertySwitcher
        activeProperty={{ id: '1', name: 'Alpha Hotels — Lagos' }}
        properties={[
          { id: '1', name: 'Alpha Hotels — Lagos' },
          { id: '2', name: 'Alpha Hotels — Abuja' },
        ]}
        onSwitchProperty={() => {}}
      />
    );
    expect(screen.getByRole('combobox')).toHaveValue('1');
  });

  it('calls onSwitchProperty with the chosen id — the actual re-verification happens server-side (SECURITY.md §3)', async () => {
    const onSwitchProperty = vi.fn();
    render(
      <PropertySwitcher
        activeProperty={{ id: '1', name: 'Alpha Hotels — Lagos' }}
        properties={[
          { id: '1', name: 'Alpha Hotels — Lagos' },
          { id: '2', name: 'Alpha Hotels — Abuja' },
        ]}
        onSwitchProperty={onSwitchProperty}
      />
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), '2');
    expect(onSwitchProperty).toHaveBeenCalledWith('2');
  });

  it('says "Choose a property" when none is active, instead of showing the first property as if it were selected', async () => {
    const onSwitchProperty = vi.fn();
    render(
      <PropertySwitcher
        activeProperty={{ id: null, name: 'No property selected' }}
        properties={[
          { id: '1', name: 'Alpha Hotels — Lagos' },
          { id: '2', name: 'Alpha Hotels — Abuja' },
        ]}
        onSwitchProperty={onSwitchProperty}
      />
    );
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose a property' })).toBeDisabled();
    await userEvent.selectOptions(select, '2');
    expect(onSwitchProperty).toHaveBeenCalledWith('2');
  });

  it('offers no "Choose a property" option once a property is active', () => {
    render(
      <PropertySwitcher
        activeProperty={{ id: '1', name: 'Alpha Hotels — Lagos' }}
        properties={[
          { id: '1', name: 'Alpha Hotels — Lagos' },
          { id: '2', name: 'Alpha Hotels — Abuja' },
        ]}
        onSwitchProperty={vi.fn()}
      />
    );
    expect(screen.queryByRole('option', { name: 'Choose a property' })).not.toBeInTheDocument();
  });

  it('labels the chip "Property" in both the name-only and switcher forms', () => {
    const one = [{ id: '1', name: 'Alpha Hotels — Lagos' }];
    const { rerender } = render(<PropertySwitcher activeProperty={one[0]} properties={one} onSwitchProperty={() => {}} />);
    expect(screen.getByText('Property')).toBeInTheDocument();
    rerender(
      <PropertySwitcher
        activeProperty={one[0]}
        properties={[...one, { id: '2', name: 'Alpha Hotels — Abuja' }]}
        onSwitchProperty={() => {}}
      />
    );
    expect(screen.getByText('Property')).toBeInTheDocument();
  });
});
