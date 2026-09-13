import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TapeChartTab } from '../TapeChartTab.jsx';

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
});
