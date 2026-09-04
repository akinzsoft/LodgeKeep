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
});
