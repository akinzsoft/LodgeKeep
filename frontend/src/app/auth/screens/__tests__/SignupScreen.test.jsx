import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupScreen } from '../SignupScreen.jsx';
import { ApiError } from '../../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ signup: vi.fn(), turnstileOnVerify: vi.fn(), turnstileAutoVerify: vi.fn(() => true), turnstileMountCount: 0 }));

vi.mock('../../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../../shared/api/index.js');
  return {
    ...actual,
    authApi: { signup: mocks.signup },
  };
});

// Security-review finding: `SignupScreen` now renders a real Cloudflare
// Turnstile widget, which loads a real third-party script no test
// environment can (or should) actually reach. Mocked here — by default it
// auto-verifies on mount so every EXISTING test below keeps passing with
// zero changes of its own; the two new CAPTCHA-specific tests further down
// override `turnstileAutoVerify` to prove the widget's own gating and the
// remount-after-failure behavior instead. The real widget's own rendering/
// callback-wiring is covered separately, unmocked, by
// `shared/components/Turnstile/__tests__/Turnstile.test.jsx`.
vi.mock('../../../../shared/components/index.js', async () => {
  const actual = await vi.importActual('../../../../shared/components/index.js');
  return {
    ...actual,
    Turnstile: ({ onVerify }) => {
      mocks.turnstileOnVerify = onVerify;
      useEffect(() => {
        // Runs exactly once per real MOUNT (empty deps) — remounting via a
        // changed `key` (SignupScreen.jsx's own fresh-widget-after-failure
        // mechanism) unmounts the old instance and runs this again on the
        // new one, which is what proves a genuine remount happened rather
        // than the same instance quietly re-rendering.
        mocks.turnstileMountCount += 1;
        if (mocks.turnstileAutoVerify()) onVerify('mock-turnstile-token');
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only stub
      }, []);
      return <div data-testid="turnstile-stub" />;
    },
  };
});

async function fillForm() {
  // The subdomain field auto-fills from the company name (`slugify.js`) —
  // typing "Riverside Hotels" here already produces the exact
  // "riverside-hotels" every test below expects, so it's deliberately not
  // typed into separately (that behavior itself is covered below).
  await userEvent.type(screen.getByLabelText(/company name/i), 'Riverside Hotels');
  await userEvent.type(screen.getByLabelText(/timezone/i), 'Africa/Lagos');
  await userEvent.type(screen.getByLabelText(/base currency/i), 'ngn');
  await userEvent.type(screen.getByLabelText(/your first name/i), 'Ada');
  await userEvent.type(screen.getByLabelText(/your last name/i), 'Okafor');
  await userEvent.type(screen.getByLabelText(/your email/i), 'ada@riverside.example');
  await userEvent.type(screen.getByLabelText('Password'), 'a genuinely long enough password');
}

describe('<SignupScreen>', () => {
  beforeEach(() => {
    mocks.signup.mockReset();
    mocks.turnstileAutoVerify.mockReset().mockReturnValue(true);
    mocks.turnstileMountCount = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits the real field names and shows a success state with no auto-login', async () => {
    mocks.signup.mockResolvedValue({ status: 'ok', trialEndsAt: '2026-10-01T00:00:00.000Z' });
    render(<SignupScreen />);

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(mocks.signup).toHaveBeenCalledWith({
      companyName: 'Riverside Hotels',
      slug: 'riverside-hotels',
      timezone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      adminFirstName: 'Ada',
      adminLastName: 'Okafor',
      adminEmail: 'ada@riverside.example',
      adminPassword: 'a genuinely long enough password',
      captchaToken: 'mock-turnstile-token',
    });
    expect(await screen.findByText(/organization is ready/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('shows the real backend error message on a duplicate slug', async () => {
    mocks.signup.mockRejectedValue(
      new ApiError({ code: 'CONFLICT_DUPLICATE_ENTRY', message: 'A tenant with slug "riverside-hotels" already exists.' })
    );
    render(<SignupScreen />);

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
  });

  it('disables submission while offline', () => {
    render(<SignupScreen isOffline />);
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();
  });

  it('auto-fills the subdomain from the company name, and stops once edited directly', async () => {
    render(<SignupScreen />);

    await userEvent.type(screen.getByLabelText(/company name/i), 'Riverside Hotels');
    expect(screen.getByLabelText(/subdomain/i)).toHaveValue('riverside-hotels');

    // Editing the subdomain directly detaches it — further company-name
    // typing must not overwrite the person's own choice.
    await userEvent.clear(screen.getByLabelText(/subdomain/i));
    await userEvent.type(screen.getByLabelText(/subdomain/i), 'my-own-slug');
    await userEvent.type(screen.getByLabelText(/company name/i), ' & Resorts');
    expect(screen.getByLabelText(/subdomain/i)).toHaveValue('my-own-slug');
  });

  it('shows a live preview of the URL the subdomain resolves to', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost', protocol: 'http:', port: '5173' });
    render(<SignupScreen />);

    await userEvent.type(screen.getByLabelText(/company name/i), 'Riverside Hotels');
    expect(screen.getByText(/riverside-hotels\.localhost:5173/)).toBeInTheDocument();
  });

  it('navigates to the new tenant\'s own subdomain, never the response tokens', async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn(), hostname: 'localhost', protocol: 'http:', port: '5173' });
    mocks.signup.mockResolvedValue({
      status: 'ok',
      accessToken: 'unused-here',
      refreshToken: 'unused-here',
      trialEndsAt: '2026-10-01T00:00:00.000Z',
    });
    render(<SignupScreen />);

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Go to sign in' }));

    expect(window.location.assign).toHaveBeenCalledWith('http://riverside-hotels.localhost:5173/');
  });

  it('disables Create organization until the CAPTCHA widget verifies', async () => {
    mocks.turnstileAutoVerify.mockReturnValue(false);
    render(<SignupScreen />);
    await fillForm();

    expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();

    mocks.turnstileOnVerify('a-real-token-arriving-later');
    expect(await screen.findByRole('button', { name: 'Create organization' })).toBeEnabled();
  });

  it('gets a fresh CAPTCHA widget (a real remount, not the same spent instance) after a failed submission', async () => {
    mocks.signup.mockRejectedValue(new ApiError({ code: 'CONFLICT_DUPLICATE_ENTRY', message: 'A tenant with slug "riverside-hotels" already exists.' }));
    render(<SignupScreen />);
    await fillForm();
    expect(mocks.turnstileMountCount).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await screen.findByRole('alert');

    // A Turnstile response token is single-use, consumed the instant the
    // backend's own siteverify call succeeds — regardless of the later
    // duplicate-slug rejection. `SignupScreen.jsx` forces a fresh widget
    // via a changed `key`, provable here as a genuine second mount (the
    // effect above re-running), not the same instance re-rendering.
    expect(mocks.turnstileMountCount).toBe(2);
  });
});
