import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfilesScreen } from '../ProfilesScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  searchGuests: vi.fn(),
  getGuestStayHistory: vi.fn(),
  getGuestActivitySummary: vi.fn(),
  listGuests: vi.fn(),
  listCompanyProfiles: vi.fn(),
  linkGuestToCompany: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    profilesApi: {
      searchGuests: mocks.searchGuests,
      getGuestStayHistory: mocks.getGuestStayHistory,
      getGuestActivitySummary: mocks.getGuestActivitySummary,
      listCompanyProfiles: mocks.listCompanyProfiles,
    },
    reservationsApi: { listGuests: mocks.listGuests, linkGuestToCompany: mocks.linkGuestToCompany },
  };
});

const GUEST = { id: '1', first_name: 'Jordan', last_name: 'Fixture', email: 'jordan@example.com', phone: '+10000000000' };
const OTHER_GUEST = { id: '2', first_name: 'Ada', last_name: 'Bello', email: 'ada@example.com', phone: '+10000000001' };

describe('<ProfilesScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listGuests.mockResolvedValue([]);
    mocks.getGuestActivitySummary.mockResolvedValue({ active: 0, inactive: 0 });
    mocks.listCompanyProfiles.mockResolvedValue([]);
  });

  /**
   * Gap closure (user-reported): "i shld be able to see all my guests" —
   * search used to be required before anyone showed up at all.
   */
  it('shows every guest by default, with no search required', async () => {
    mocks.listGuests.mockResolvedValue([GUEST, OTHER_GUEST]);
    render(<ProfilesScreen />);
    expect(await screen.findByText('jordan@example.com')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('All guests')).toBeInTheDocument();
    expect(mocks.searchGuests).not.toHaveBeenCalled();
  });

  it('shows the real backend error when the full guest list fails to load', async () => {
    mocks.listGuests.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Could not reach the guest directory.' }));
    render(<ProfilesScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the guest directory.');
  });

  it('searches and narrows to matching guests, replacing the full list', async () => {
    mocks.listGuests.mockResolvedValue([GUEST, OTHER_GUEST]);
    mocks.searchGuests.mockResolvedValue([GUEST]);
    render(<ProfilesScreen />);
    await screen.findByText('ada@example.com');

    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'Jordan');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(mocks.searchGuests).toHaveBeenCalledWith('Jordan');
    expect(await screen.findByText('jordan@example.com')).toBeInTheDocument();
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('Search results')).toBeInTheDocument();
  });

  it('"Show all guests" clears the search and returns to the full list', async () => {
    mocks.listGuests.mockResolvedValue([GUEST, OTHER_GUEST]);
    mocks.searchGuests.mockResolvedValue([GUEST]);
    render(<ProfilesScreen />);
    await screen.findByText('ada@example.com');

    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'Jordan');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Search results');

    await userEvent.click(screen.getByRole('button', { name: 'Show all guests' }));
    expect(await screen.findByText('All guests')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches a search', async () => {
    mocks.listGuests.mockResolvedValue([GUEST]);
    mocks.searchGuests.mockResolvedValue([]);
    render(<ProfilesScreen />);
    await screen.findByText('jordan@example.com');
    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'nobody');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/no guests match this search/i)).toBeInTheDocument();
  });

  it('selects a guest and loads their stay history', async () => {
    mocks.listGuests.mockResolvedValue([GUEST]);
    mocks.getGuestStayHistory.mockResolvedValue([
      { id: '10', confirmation_number: 'ABC123', arrival_date: '2027-01-01', departure_date: '2027-01-02', status: 'checked_out' },
    ]);
    render(<ProfilesScreen />);
    await screen.findByText('jordan@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'View profile' }));

    expect(mocks.getGuestStayHistory).toHaveBeenCalledWith('1');
    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(screen.getAllByText('Jordan Fixture').length).toBeGreaterThan(0);
  });

  it('shows the backend error message on a failed search', async () => {
    mocks.listGuests.mockResolvedValue([]);
    mocks.searchGuests.mockRejectedValue(new ApiError({ code: 'VALIDATION_MISSING_FIELD', message: '"q" is required.' }));
    render(<ProfilesScreen />);
    await screen.findByText('All guests');
    await userEvent.type(screen.getByLabelText(/name, email, or phone/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('is required');
  });

  /**
   * Gap closure (user-reported): "export to pdf" — the browser's own print
   * dialog, confirmed with the user before building (no PDF library exists
   * in this codebase).
   */
  it('Export to PDF calls the browser print dialog', async () => {
    mocks.listGuests.mockResolvedValue([GUEST]);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ProfilesScreen />);
    await screen.findByText('jordan@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Export to PDF' }));
    expect(printSpy).toHaveBeenCalled();
    printSpy.mockRestore();
  });

  it('does not show an Export to PDF button when the guest list is empty', async () => {
    mocks.listGuests.mockResolvedValue([]);
    render(<ProfilesScreen />);
    await screen.findByText('All guests');
    expect(screen.queryByRole('button', { name: 'Export to PDF' })).not.toBeInTheDocument();
  });

  /**
   * Gap closure (user-reported): "add summary report on the profile num of
   * active and inactive customer. also i hsld be able to click to see
   * active or inactive customers."
   */
  describe('active/inactive summary', () => {
    it('shows the real active/inactive counts', async () => {
      mocks.getGuestActivitySummary.mockResolvedValue({ active: 3, inactive: 11 });
      render(<ProfilesScreen />);
      expect(await screen.findByText('3')).toBeInTheDocument();
      expect(screen.getByText('11')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Inactive')).toBeInTheDocument();
    });

    it('shows the real backend error if the summary fails to load, without breaking the rest of the screen', async () => {
      mocks.listGuests.mockResolvedValue([GUEST]);
      mocks.getGuestActivitySummary.mockRejectedValue(new ApiError({ code: 'INTERNAL_ERROR', message: 'Could not load the summary.' }));
      render(<ProfilesScreen />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the summary.');
      expect(await screen.findByText('jordan@example.com')).toBeInTheDocument();
    });

    it('clicking "Active" filters the list to active guests only, via a real API call', async () => {
      mocks.getGuestActivitySummary.mockResolvedValue({ active: 1, inactive: 1 });
      mocks.listGuests.mockImplementation((params) =>
        Promise.resolve(params?.activity === 'active' ? [GUEST] : [GUEST, OTHER_GUEST])
      );
      render(<ProfilesScreen />);
      await screen.findByText('ada@example.com');

      await userEvent.click(screen.getByRole('button', { name: 'Active guests' }));

      expect(mocks.listGuests).toHaveBeenCalledWith({ activity: 'active' });
      expect(await screen.findByText('Active guests')).toBeInTheDocument();
      expect(screen.getByText('jordan@example.com')).toBeInTheDocument();
      expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Active guests' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('clicking "Inactive" filters the list to inactive guests only', async () => {
      mocks.getGuestActivitySummary.mockResolvedValue({ active: 1, inactive: 1 });
      mocks.listGuests.mockImplementation((params) =>
        Promise.resolve(params?.activity === 'inactive' ? [OTHER_GUEST] : [GUEST, OTHER_GUEST])
      );
      render(<ProfilesScreen />);
      await screen.findByText('jordan@example.com');

      await userEvent.click(screen.getByRole('button', { name: 'Inactive guests' }));

      expect(mocks.listGuests).toHaveBeenCalledWith({ activity: 'inactive' });
      expect(await screen.findByText('Inactive guests')).toBeInTheDocument();
      expect(screen.getByText('ada@example.com')).toBeInTheDocument();
      expect(screen.queryByText('jordan@example.com')).not.toBeInTheDocument();
    });

    it('"Show all guests" clears an activity filter and returns to the full list', async () => {
      mocks.getGuestActivitySummary.mockResolvedValue({ active: 1, inactive: 1 });
      mocks.listGuests.mockImplementation((params) =>
        Promise.resolve(params?.activity === 'active' ? [GUEST] : [GUEST, OTHER_GUEST])
      );
      render(<ProfilesScreen />);
      await screen.findByText('ada@example.com');

      await userEvent.click(screen.getByRole('button', { name: 'Active guests' }));
      await screen.findByText('Active guests');

      await userEvent.click(screen.getByRole('button', { name: 'Show all guests' }));
      expect(await screen.findByText('All guests')).toBeInTheDocument();
      expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    });
  });

  /**
   * PLAN.md Phase 4 (Accounts Receivable) — a "Companies" tab, alongside
   * the pre-existing Guests view (unchanged, tested above).
   */
  describe('Companies tab and linked-company picker', () => {
    it('defaults to the Guests tab', async () => {
      render(<ProfilesScreen />);
      expect(await screen.findByRole('tab', { name: 'Guests' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Companies' })).toHaveAttribute('aria-selected', 'false');
    });

    it('switching to the Companies tab renders company-profile management, not the guest list', async () => {
      mocks.listCompanyProfiles.mockResolvedValue([{ id: '50', name: 'Acme Corp', type: 'company', billing_email: 'ap@acme.test' }]);
      render(<ProfilesScreen />);
      await screen.findByText('All guests');

      await userEvent.click(screen.getByRole('tab', { name: 'Companies' }));

      expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
      expect(screen.queryByText('All guests')).not.toBeInTheDocument();
    });

    it('shows a "Linked company" picker on a selected guest and saves the link', async () => {
      mocks.listGuests.mockResolvedValue([GUEST]);
      mocks.listCompanyProfiles.mockResolvedValue([{ id: '50', name: 'Acme Corp' }]);
      mocks.getGuestStayHistory.mockResolvedValue([]);
      mocks.linkGuestToCompany.mockResolvedValue({ ...GUEST, company_profile_id: '50' });
      render(<ProfilesScreen />);
      await screen.findByText('jordan@example.com');

      await userEvent.click(screen.getByRole('button', { name: 'View profile' }));
      await screen.findByLabelText('Linked company');

      await userEvent.selectOptions(screen.getByLabelText('Linked company'), '50');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(mocks.linkGuestToCompany).toHaveBeenCalledWith('1', '50');
    });
  });
});
