import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfilesScreen } from '../ProfilesScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  searchGuests: vi.fn(),
  getGuestStayHistory: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    profilesApi: { searchGuests: mocks.searchGuests, getGuestStayHistory: mocks.getGuestStayHistory },
  };
});

const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture', email: 'jordan@example.com', phone: '+10000000000' };

describe('<ProfilesScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('renders no results table before a search is run', () => {
    render(<ProfilesScreen />);
    expect(screen.queryByText('Results')).not.toBeInTheDocument();
  });

  it('searches and shows matching guests', async () => {
    mocks.searchGuests.mockResolvedValue([GUEST]);
    render(<ProfilesScreen />);

    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'Jordan');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(mocks.searchGuests).toHaveBeenCalledWith('Jordan');
    expect(await screen.findByText('jordan@example.com')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    mocks.searchGuests.mockResolvedValue([]);
    render(<ProfilesScreen />);
    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'nobody');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/no guests match this search/i)).toBeInTheDocument();
  });

  it('selects a guest and loads their stay history', async () => {
    mocks.searchGuests.mockResolvedValue([GUEST]);
    mocks.getGuestStayHistory.mockResolvedValue([
      { id: '10', confirmation_number: 'ABC123', arrival_date: '2027-01-01', departure_date: '2027-01-02', status: 'checked_out' },
    ]);
    render(<ProfilesScreen />);
    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'Jordan');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('jordan@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'View profile' }));

    expect(mocks.getGuestStayHistory).toHaveBeenCalledWith('1');
    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(screen.getAllByText('Jordan Fixture').length).toBeGreaterThan(0);
  });

  it('shows the backend error message on a failed search', async () => {
    mocks.searchGuests.mockRejectedValue(new ApiError({ code: 'VALIDATION_MISSING_FIELD', message: '"q" is required.' }));
    render(<ProfilesScreen />);
    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('is required');
  });
});
