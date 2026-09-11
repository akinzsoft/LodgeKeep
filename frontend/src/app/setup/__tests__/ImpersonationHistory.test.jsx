import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupScreen } from '../SetupScreen.jsx';
const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../../../shared/api/setup.js', () => ({ listProperties: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../shared/api/platform.js', () => ({ listOwnImpersonationSessions: mocks.history }));

describe('tenant-visible support history', () => {
  it('is reachable from Setup and displays who, why, property, and session times', async () => {
    mocks.history.mockResolvedValue([{ id: '1', property_id: '20', reason: 'Investigate arrival',
      platform_user: { email: 'ops@lodgekeep.test' }, started_at: '2026-08-31T10:00:00Z',
      ended_at: '2026-08-31T10:05:00Z', expires_at: '2026-08-31T11:00:00Z' }]);
    render(<SetupScreen activePropertyId="20" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Support access' }));
    expect(await screen.findByText('ops@lodgekeep.test')).toBeInTheDocument();
    expect(screen.getByText('Investigate arrival')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('2026-08-31T10:05:00Z')).toBeInTheDocument();
    expect(mocks.history).toHaveBeenCalledWith();
  });
});
