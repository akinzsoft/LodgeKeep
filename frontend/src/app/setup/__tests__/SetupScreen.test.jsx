import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupScreen } from '../SetupScreen.jsx';

const mocks = vi.hoisted(() => ({
  listProperties: vi.fn(),
  listRoomTypes: vi.fn(),
  listRooms: vi.fn(),
  listRateCodes: vi.fn(),
  listTaxes: vi.fn(),
  listMarketSegments: vi.fn(),
  listBookingSources: vi.fn(),
  listCancellationPolicies: vi.fn(),
  getSetupProgress: vi.fn(),
}));

const usersMocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listPendingInvitations: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listProperties: mocks.listProperties,
      listRoomTypes: mocks.listRoomTypes,
      listRooms: mocks.listRooms,
      listRateCodes: mocks.listRateCodes,
      listTaxes: mocks.listTaxes,
      listMarketSegments: mocks.listMarketSegments,
      listBookingSources: mocks.listBookingSources,
      listCancellationPolicies: mocks.listCancellationPolicies,
      getSetupProgress: mocks.getSetupProgress,
    },
    usersApi: {
      listUsers: usersMocks.listUsers,
      listPendingInvitations: usersMocks.listPendingInvitations,
    },
  };
});

const PROPERTY = { id: '1', name: 'Alpha Hotels', slug: 'alpha', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2026-09-01' };

describe('<SetupScreen>', () => {
  beforeEach(() => {
    [...Object.values(mocks), ...Object.values(usersMocks)].forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
    mocks.listRateCodes.mockResolvedValue([]);
    mocks.listTaxes.mockResolvedValue([]);
    mocks.listMarketSegments.mockResolvedValue([]);
    mocks.listBookingSources.mockResolvedValue([]);
    mocks.listCancellationPolicies.mockResolvedValue([]);
    mocks.getSetupProgress.mockResolvedValue({
      steps: [
        { key: 'property', label: 'Property', complete: true },
        { key: 'room-types', label: 'Room Types', complete: false },
        { key: 'rooms', label: 'Rooms', complete: false },
        { key: 'rate-codes', label: 'Rate Codes & Calendar', complete: false },
        { key: 'taxes', label: 'Taxes', complete: false, optional: true },
        { key: 'users', label: 'Users', complete: false, optional: true },
      ],
      operational: false,
    });
    usersMocks.listUsers.mockResolvedValue([]);
    usersMocks.listPendingInvitations.mockResolvedValue([]);
  });

  it('shows a loading state before properties resolve', () => {
    mocks.listProperties.mockImplementation(() => new Promise(() => {}));
    render(<SetupScreen activePropertyId="1" />);
    expect(screen.getByText(/loading setup/i)).toBeInTheDocument();
  });

  it('renders every tab once properties load, defaulting to Guided Setup', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<SetupScreen activePropertyId="1" />);
    expect(await screen.findByRole('tab', { name: 'Guided Setup' })).toHaveAttribute('aria-selected', 'true');
    ['Property', 'Room Types', 'Rooms', 'Rate Codes & Calendar', 'Taxes', 'Reference Data', 'Users'].forEach((label) => {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    });
  });

  it('switches tabs on click', async () => {
    mocks.listProperties.mockResolvedValue([PROPERTY]);
    render(<SetupScreen activePropertyId="1" />);
    await screen.findByRole('tab', { name: 'Property' });

    await userEvent.click(screen.getByRole('tab', { name: 'Room Types' }));
    expect(screen.getByRole('tab', { name: 'Room Types' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Property' })).toHaveAttribute('aria-selected', 'false');
  });

  it('disables property-dependent tabs with an explanatory notice when no property exists yet', async () => {
    mocks.listProperties.mockResolvedValue([]);
    render(<SetupScreen activePropertyId={null} />);
    await screen.findByRole('tab', { name: 'Property' });

    await userEvent.click(screen.getByRole('tab', { name: 'Room Types' }));
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
  });

  it('shows an error banner when properties fail to load', async () => {
    mocks.listProperties.mockRejectedValue(new Error('network down'));
    render(<SetupScreen activePropertyId="1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
