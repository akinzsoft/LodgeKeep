import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupScreen } from '../SignupScreen.jsx';
import { ApiError } from '../../../../shared/api/ApiError.js';

const mocks = vi.hoisted(() => ({ signup: vi.fn() }));

vi.mock('../../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../../shared/api/index.js');
  return {
    ...actual,
    authApi: { signup: mocks.signup },
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
});
