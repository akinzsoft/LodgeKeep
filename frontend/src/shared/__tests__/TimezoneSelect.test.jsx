import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneSelect } from '../components/TimezoneSelect.jsx';
import { listTimezones, isValidTimezone, DEFAULT_TIMEZONE } from '../timezones.js';

describe('timezones', () => {
  it('offers real IANA zones including the default', () => {
    expect(DEFAULT_TIMEZONE).toBe('Africa/Lagos');
    expect(isValidTimezone('Africa/Lagos')).toBe(true);
    expect(listTimezones().length).toBeGreaterThan(100);
    for (const bad of ['Lagos', 'LAGOS', 'Africa', 'Africa/Asaba', '']) expect(isValidTimezone(bad)).toBe(false);
  });
});

describe('<TimezoneSelect>', () => {
  it('shows a valid value as selected and reports a change', async () => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="Africa/Lagos" onChange={onChange} />);
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('Africa/Lagos');
    await userEvent.selectOptions(select, 'Africa/Accra');
    expect(onChange).toHaveBeenCalledWith('Africa/Accra');
  });

  it('shows a stored non-IANA value as unselected, naming it, so one must be chosen', () => {
    render(<TimezoneSelect value="LAGOS" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByText(/"LAGOS" is not a valid timezone/)).toBeInTheDocument();
  });
});
