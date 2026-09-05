import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceDataTab } from '../ReferenceDataTab.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({
  listMarketSegments: vi.fn(),
  createMarketSegment: vi.fn(),
  listBookingSources: vi.fn(),
  createBookingSource: vi.fn(),
  listCancellationPolicies: vi.fn(),
  createCancellationPolicy: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      listMarketSegments: mocks.listMarketSegments,
      createMarketSegment: mocks.createMarketSegment,
      listBookingSources: mocks.listBookingSources,
      createBookingSource: mocks.createBookingSource,
      listCancellationPolicies: mocks.listCancellationPolicies,
      createCancellationPolicy: mocks.createCancellationPolicy,
    },
  };
});

function mockEmptyLists() {
  mocks.listMarketSegments.mockResolvedValue([]);
  mocks.listBookingSources.mockResolvedValue([]);
  mocks.listCancellationPolicies.mockResolvedValue([]);
}

describe('<ReferenceDataTab>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('shows a disabled notice with no active property, and never calls the API', () => {
    render(<ReferenceDataTab disabled />);
    expect(screen.getByText(/create a property first/i)).toBeInTheDocument();
    expect(mocks.listMarketSegments).not.toHaveBeenCalled();
  });

  it('shows the empty state for all three lists with nothing seeded', async () => {
    mockEmptyLists();
    render(<ReferenceDataTab disabled={false} />);
    expect(await screen.findByText(/no market segments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no booking sources yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no cancellation policies yet/i)).toBeInTheDocument();
  });

  it('creates a market segment and reloads the list', async () => {
    mocks.listMarketSegments.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '1', code: 'CORP', name: 'Corporate' }]);
    mocks.listBookingSources.mockResolvedValue([]);
    mocks.listCancellationPolicies.mockResolvedValue([]);
    mocks.createMarketSegment.mockResolvedValue({ id: '1', code: 'CORP' });
    render(<ReferenceDataTab disabled={false} />);
    await screen.findByText(/no market segments yet/i);

    await userEvent.type(screen.getByPlaceholderText('CORP'), 'CORP');
    await userEvent.type(screen.getByPlaceholderText('Corporate'), 'Corporate');
    await userEvent.click(screen.getByRole('button', { name: 'Add market segment' }));

    expect(mocks.createMarketSegment).toHaveBeenCalledWith({ code: 'CORP', name: 'Corporate' });
    expect(await screen.findByText('Corporate')).toBeInTheDocument();
  });

  it('creates a cancellation policy with a fee rule', async () => {
    mockEmptyLists();
    mocks.createCancellationPolicy.mockResolvedValue({ id: '1', code: 'STRICT' });
    mocks.listCancellationPolicies
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '1', code: 'STRICT', name: 'Strict', cutoff_hours: 48, fee_type: 'first_night' }]);
    render(<ReferenceDataTab disabled={false} />);
    await screen.findByText(/no cancellation policies yet/i);

    await userEvent.type(screen.getByPlaceholderText('FLEX'), 'STRICT');
    await userEvent.type(screen.getByPlaceholderText('Flexible'), 'Strict');
    await userEvent.type(screen.getByPlaceholderText('48'), '48');
    await userEvent.selectOptions(screen.getByLabelText(/fee type/i), 'first_night');
    await userEvent.click(screen.getByRole('button', { name: 'Add cancellation policy' }));

    expect(mocks.createCancellationPolicy).toHaveBeenCalledWith({
      code: 'STRICT',
      name: 'Strict',
      cutoff_hours: 48,
      fee_type: 'first_night',
      fee_value: undefined,
    });
    expect(await screen.findByText('Strict')).toBeInTheDocument();
  });

  it('shows the backend error message on a duplicate booking source code', async () => {
    mockEmptyLists();
    mocks.createBookingSource.mockRejectedValue(
      new ApiError({ code: 'CONFLICT_DUPLICATE_ENTRY', message: 'A booking source with code "DIRECT" already exists at this property.' })
    );
    render(<ReferenceDataTab disabled={false} />);
    await screen.findByText(/no booking sources yet/i);

    await userEvent.type(screen.getByPlaceholderText('DIRECT'), 'DIRECT');
    await userEvent.type(screen.getByPlaceholderText('Direct'), 'Direct');
    await userEvent.click(screen.getByRole('button', { name: 'Add booking source' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists at this property');
  });
});
