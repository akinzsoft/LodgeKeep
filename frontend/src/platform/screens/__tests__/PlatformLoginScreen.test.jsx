import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider } from '../../auth/PlatformAuthContext.jsx';
import { PlatformLoginScreen } from '../PlatformLoginScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ login: vi.fn(), configureApiClient: vi.fn() }));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, login: mocks.login }, configureApiClient: mocks.configureApiClient };
});

function renderScreen() {
  return render(
    <PlatformAuthProvider>
      <PlatformLoginScreen />
    </PlatformAuthProvider>
  );
}

describe('<PlatformLoginScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
  });

  it('submits email and password', async () => {
    mocks.login.mockResolvedValue({ status: 'mfa_challenge_required', challengeToken: 'token' });
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'ops@lodgekeep.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a real password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mocks.login).toHaveBeenCalledWith('ops@lodgekeep.test', 'a real password');
  });

  it('surfaces a real backend error', async () => {
    mocks.login.mockRejectedValue(new ApiError({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' }));
    renderScreen();

    await userEvent.type(screen.getByLabelText('Email'), 'ops@lodgekeep.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });
});
