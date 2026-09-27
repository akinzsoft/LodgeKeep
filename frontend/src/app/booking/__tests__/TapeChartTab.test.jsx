import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TapeChartTab, nightTone } from '../TapeChartTab.jsx';

const mocks = vi.hoisted(() => ({
  listRoomTypes: vi.fn(),
  checkAvailability: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: { listRoomTypes: mocks.listRoomTypes },
    reservationsApi: { checkAvailability: mocks.checkAvailability },
  };
});

const ROOM_TYPE = { id: '1', name: 'Deluxe' };

describe('<TapeChartTab>', () => {
  beforeEach(() => {
    mocks.listRoomTypes.mockReset();
    mocks.checkAvailability.mockReset();
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
    mocks.checkAvailability.mockResolvedValue({ nights: [{ stayDate: '2026-09-10', physicalCount: 5, sellable: 5 }] });
  });

  it("bug fix: defaults the window to the property's own business date, not the browser's wall-clock today", async () => {
    render(<TapeChartTab activeProperty={{ current_business_date: '2026-09-10' }} />);

    expect(await screen.findByDisplayValue('2026-09-10')).toBeInTheDocument();
    expect(mocks.checkAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ arrivalDate: '2026-09-10' })
    );
  });

  it('falls back to wall-clock today when the property has no business date configured yet', async () => {
    const today = new Date().toISOString().slice(0, 10);
    render(<TapeChartTab activeProperty={{ current_business_date: null }} />);

    expect(await screen.findByDisplayValue(today)).toBeInTheDocument();
  });

  it('still falls back to wall-clock today with no activeProperty prop at all', async () => {
    const today = new Date().toISOString().slice(0, 10);
    render(<TapeChartTab />);

    expect(await screen.findByDisplayValue(today)).toBeInTheDocument();
  });

  it('moves a week at a time, and Today returns to the business date', async () => {
    render(<TapeChartTab activeProperty={{ current_business_date: '2026-09-10' }} />);
    await screen.findByDisplayValue('2026-09-10');
    expect(screen.getByRole('button', { name: 'Today' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next week ▶' }));
    await waitFor(() => expect(mocks.checkAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ arrivalDate: '2026-09-17' })));
    expect(screen.getByText('Thu 17 Sep – Wed 30 Sep 2026')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(mocks.checkAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ arrivalDate: '2026-09-10' })));
  });

  it('labels each column with its weekday and marks the business date', async () => {
    render(<TapeChartTab activeProperty={{ current_business_date: '2026-09-10' }} />);
    const header = (await screen.findAllByText('10')).find((node) => node.parentElement?.getAttribute('aria-current') === 'date');
    expect(header.parentElement).toHaveAttribute('aria-current', 'date');
    expect(header.parentElement).toHaveTextContent('Thu');
  });
});

describe('<TapeChartTab> week navigation races', () => {
  beforeEach(() => {
    mocks.listRoomTypes.mockReset();
    mocks.checkAvailability.mockReset();
    mocks.listRoomTypes.mockResolvedValue([ROOM_TYPE]);
  });

  it("a slow answer for a week the user has moved past never replaces the newer week's grid", async () => {
    const answers = {};
    mocks.checkAvailability.mockImplementation(({ arrivalDate }) => new Promise((resolve) => (answers[arrivalDate] = resolve)));
    render(<TapeChartTab activeProperty={{ current_business_date: '2026-09-10' }} />);
    await waitFor(() => expect(answers['2026-09-10']).toBeDefined());
    answers['2026-09-10']({ nights: [{ stayDate: '2026-09-10', physicalCount: 5, sellable: 5 }] });
    await screen.findByText('Thu');

    await userEvent.click(screen.getByRole('button', { name: 'Next week ▶' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next week ▶' }));
    await waitFor(() => expect(answers['2026-09-24']).toBeDefined());
    answers['2026-09-24']({ nights: [{ stayDate: '2026-09-24', physicalCount: 5, sellable: 2 }] });
    answers['2026-09-17']({ nights: [{ stayDate: '2026-09-17', physicalCount: 5, sellable: 4 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('24')).toBeInTheDocument();
    expect(screen.queryByText('17')).not.toBeInTheDocument();
  });
});

describe('nightTone', () => {
  it('is full with nothing free, and never "nearly full" while a single-room type\'s room is free', () => {
    expect(nightTone({ sellable: 0, physicalCount: 5 })).toBe('full');
    expect(nightTone({ sellable: 1, physicalCount: 1 })).toBe('available');
    expect(nightTone({ sellable: 5, physicalCount: 5 })).toBe('available');
  });

  it('is nearly full once a fifth or less is free', () => {
    expect(nightTone({ sellable: 2, physicalCount: 10 })).toBe('tight');
    expect(nightTone({ sellable: 3, physicalCount: 10 })).toBe('available');
  });
});
