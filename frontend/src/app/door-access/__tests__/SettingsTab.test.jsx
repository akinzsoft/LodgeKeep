import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsTab } from '../SettingsTab.jsx';

/**
 * Gap closure: per-property door-event retention (PRODUCT_REQUIREMENTS.md
 * §3.23's legal/privacy note). No dedicated test existed for this tab at
 * all before this pass — `DoorAccessScreen.test.jsx` only asserts the tab
 * names exist, never renders this one's own content.
 */

const mocks = vi.hoisted(() => ({ updateConfig: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, doorAccessApi: { ...actual.doorAccessApi, ...mocks }, ApiError: actual.ApiError };
});

const BASE_CONFIG = {
  id: '1',
  adapter: 'hiread_prousb',
  ingestionMode: 'manual_import',
  postCheckoutGraceMinutes: 15,
  retentionDays: null,
  importMapping: null,
  lastImportAt: null,
  supportsRealtime: false,
  timezone: 'Africa/Lagos',
};

beforeEach(() => {
  mocks.updateConfig.mockReset();
});

describe('<SettingsTab> retention', () => {
  it('shows the "kept indefinitely" state when no retention window is configured', () => {
    render(<SettingsTab config={BASE_CONFIG} onSaved={() => {}} />);
    expect(screen.getByLabelText('Door event retention (days)')).toHaveValue(null);
    expect(screen.getByText(/kept indefinitely/i)).toBeInTheDocument();
  });

  it('a config object with no retentionDays key at all (an older cached/mocked shape) renders empty, not the literal string "undefined"', () => {
    const withoutRetention = {
      id: '1',
      adapter: 'hiread_prousb',
      ingestionMode: 'manual_import',
      postCheckoutGraceMinutes: 15,
      importMapping: null,
      lastImportAt: null,
      supportsRealtime: false,
      timezone: 'Africa/Lagos',
    };
    render(<SettingsTab config={withoutRetention} onSaved={() => {}} />);
    expect(screen.getByLabelText('Door event retention (days)')).toHaveValue(null);
  });

  it('shows the real configured number and its purge explanation', () => {
    render(<SettingsTab config={{ ...BASE_CONFIG, retentionDays: 90 }} onSaved={() => {}} />);
    expect(screen.getByLabelText('Door event retention (days)')).toHaveValue(90);
    expect(screen.getByText(/older than 90 days are deleted automatically/i)).toBeInTheDocument();
  });

  it('saves a real retention window and disables submit while the typed value is out of range', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mocks.updateConfig.mockResolvedValue({ ...BASE_CONFIG, retentionDays: 30 });
    render(<SettingsTab config={BASE_CONFIG} onSaved={onSaved} />);

    const field = screen.getByLabelText('Door event retention (days)');
    await user.clear(field);
    await user.type(field, '3651');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    await user.clear(field);
    await user.type(field, '30');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(mocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 30 }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...BASE_CONFIG, retentionDays: 30 }));
  });

  it('clearing the field back to empty sends null, turning automatic purging back off', async () => {
    const user = userEvent.setup();
    mocks.updateConfig.mockResolvedValue(BASE_CONFIG);
    render(<SettingsTab config={{ ...BASE_CONFIG, retentionDays: 90 }} onSaved={() => {}} />);

    const field = screen.getByLabelText('Door event retention (days)');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(mocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: null }));
  });
});
