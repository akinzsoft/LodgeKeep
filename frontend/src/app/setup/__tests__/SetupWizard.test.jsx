import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupWizard } from '../SetupWizard.jsx';

const mocks = vi.hoisted(() => ({
  getSetupProgress: vi.fn(),
  listRoomTypes: vi.fn(),
  listRooms: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return {
    ...actual,
    setupApi: {
      ...actual.setupApi,
      getSetupProgress: mocks.getSetupProgress,
      listRoomTypes: mocks.listRoomTypes,
      listRooms: mocks.listRooms,
    },
  };
});

const PROPERTY = { id: '1', name: 'Alpha Hotels', base_currency: 'NGN' };

const INCOMPLETE_PROGRESS = {
  steps: [
    { key: 'property', label: 'Property', complete: true },
    { key: 'room-types', label: 'Room Types', complete: false },
    { key: 'rooms', label: 'Rooms', complete: false },
    { key: 'rate-codes', label: 'Rate Codes & Calendar', complete: false },
    { key: 'taxes', label: 'Taxes', complete: false, optional: true },
    { key: 'users', label: 'Users', complete: false, optional: true },
  ],
  operational: false,
};

describe('<SetupWizard>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.listRoomTypes.mockResolvedValue([]);
    mocks.listRooms.mockResolvedValue([]);
  });

  it('auto-resumes at the first incomplete step', async () => {
    mocks.getSetupProgress.mockResolvedValue(INCOMPLETE_PROGRESS);
    render(<SetupWizard properties={[PROPERTY]} activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);

    expect(await screen.findByText(/not yet operational/i)).toBeInTheDocument();
    // Room Types is the first incomplete step — its own "Add a room type" form should be visible.
    expect(await screen.findByRole('button', { name: 'Add room type' })).toBeInTheDocument();
  });

  it('shows a checkmark for a completed step and lets an admin click back to it', async () => {
    mocks.getSetupProgress.mockResolvedValue(INCOMPLETE_PROGRESS);
    render(<SetupWizard properties={[PROPERTY]} activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Add room type' });

    const propertyStepButton = screen.getByRole('button', { name: /✓ Property/ });
    await userEvent.click(propertyStepButton);
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
  });

  it('shows the operational message once every required step is complete', async () => {
    mocks.getSetupProgress.mockResolvedValue({
      steps: INCOMPLETE_PROGRESS.steps.map((step) => ({ ...step, complete: true })),
      operational: true,
    });
    render(<SetupWizard properties={[PROPERTY]} activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    expect(await screen.findByText(/this property is operational/i)).toBeInTheDocument();
  });

  it('disables Back on the first step and moves forward on Next', async () => {
    mocks.getSetupProgress.mockResolvedValue({
      steps: INCOMPLETE_PROGRESS.steps.map((step) => ({ ...step, complete: true })),
      operational: true,
    });
    render(<SetupWizard properties={[PROPERTY]} activeProperty={PROPERTY} onPropertiesChanged={vi.fn()} />);
    await screen.findByText(/this property is operational/i);

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: 'Add room type' })).toBeInTheDocument();
  });
});
