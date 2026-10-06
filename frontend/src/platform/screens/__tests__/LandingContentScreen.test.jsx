import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAuthProvider } from '../../auth/PlatformAuthContext.jsx';
import { LandingContentScreen } from '../LandingContentScreen.jsx';
import { ApiError } from '../../../shared/api/ApiError.js';
import { content as defaults } from '../../../landing/landingContent.js';

const mocks = vi.hoisted(() => ({
  getLandingContent: vi.fn(),
  saveLandingContent: vi.fn(),
  resetLandingContent: vi.fn(),
  restoreLandingContentVersion: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock('../../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../../shared/api/index.js');
  return { ...actual, platformApi: { ...actual.platformApi, ...mocks }, configureApiClient: mocks.configureApiClient };
});

const VERSION = (id, content, note = 'Saved') => ({ id: String(id), content, note, created_by_platform_user_id: '1', created_at: '2026-10-07 09:00:00' });
const VIEW = (current, versions = current ? [current] : []) => ({ current, versions, monthly: { amount: '35000.00', currency: 'NGN', interval: 'monthly' }, trialDays: 14 });

function renderScreen() {
  return render(
    <PlatformAuthProvider>
      <LandingContentScreen onBack={vi.fn()} onLogout={vi.fn()} />
    </PlatformAuthProvider>
  );
}

describe('<LandingContentScreen>', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.getLandingContent.mockResolvedValue(VIEW(null));
  });

  it('shows the live monthly fee and trial length as read-only facts, with no way to edit them', async () => {
    renderScreen();
    expect((await screen.findByText(/Monthly fee:/)).parentElement).toHaveTextContent(/35,000\.00 per month/);
    expect(screen.getByText(/Free trial:/).parentElement).toHaveTextContent('14 days');
    expect(screen.queryByLabelText(/monthly fee/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/trial/i)).not.toBeInTheDocument();
  });

  it('starts from the live page content (defaults plus saved overrides)', async () => {
    mocks.getLandingContent.mockResolvedValue(VIEW(VERSION(4, { hero: { headline: 'Saved headline' }, contact: { email: 'new@planmsys.com' } })));
    renderScreen();
    expect(await screen.findByLabelText('Headline')).toHaveValue('Saved headline');
    expect(screen.getByLabelText('Email')).toHaveValue('new@planmsys.com');
    expect(screen.getByLabelText('WhatsApp number')).toHaveValue(defaults.contact.whatsapp);
    expect(screen.getByLabelText('One-time setup fee')).toHaveValue(defaults.pricing.setupAmount);
  });

  it('saves only what was changed from the defaults', async () => {
    mocks.saveLandingContent.mockResolvedValue(VERSION(5, {}));
    renderScreen();
    const headline = await screen.findByLabelText('Headline');
    await userEvent.clear(headline);
    await userEvent.type(headline, 'A better headline');
    await userEvent.clear(screen.getByLabelText('WhatsApp number'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.saveLandingContent).toHaveBeenCalledWith({ hero: { headline: 'A better headline' }, contact: { whatsapp: '' } });
    expect(await screen.findByRole('status')).toHaveTextContent(/Saved/);
    expect(mocks.getLandingContent).toHaveBeenCalledTimes(2);
  });

  it('turns the included list and testimonials into the saved shape, dropping blanks', async () => {
    mocks.saveLandingContent.mockResolvedValue(VERSION(5, {}));
    renderScreen();
    const includes = await screen.findByLabelText(/What's included/);
    await userEvent.clear(includes);
    await userEvent.type(includes, 'First thing{enter}{enter}Second thing');
    await userEvent.click(screen.getByRole('button', { name: 'Add a testimonial' }));
    await userEvent.type(screen.getByLabelText('Quote 1'), 'It works.');
    await userEvent.type(screen.getByLabelText('Name 1'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.saveLandingContent).toHaveBeenCalledWith({
      pricing: { includes: ['First thing', 'Second thing'] },
      testimonials: { items: [{ quote: 'It works.', name: 'Ada', role: '' }] },
    });
  });

  it('shows the server\'s field problems next to the fields and keeps what was typed', async () => {
    mocks.saveLandingContent.mockRejectedValueOnce(
      new ApiError({ code: 'VALIDATION_INVALID_CONTENT', message: 'Some of the landing page content is not valid.', status: 400, details: [{ field: 'contact.email', issue: 'invalid', message: 'contact.email must be a valid email address.' }] })
    );
    renderScreen();
    const email = await screen.findByLabelText('Email');
    await userEvent.clear(email);
    await userEvent.type(email, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('contact.email must be a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Some of the landing page content is not valid.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('nope');
  });

  it('says plainly that a support account can look but not save, and shows the server refusal', async () => {
    mocks.saveLandingContent.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN_PLATFORM_ROLE', message: 'This action needs the platform admin tier.', status: 403 }));
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This action needs the platform admin tier.')).toBeInTheDocument();
  });

  it('resets to the defaults only after a confirmation that says what happens', async () => {
    mocks.resetLandingContent.mockResolvedValue(VERSION(6, {}, 'Reset to defaults'));
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: 'Reset everything to the defaults' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/previous version/);
    expect(mocks.resetLandingContent).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset to defaults' }));
    expect(mocks.resetLandingContent).toHaveBeenCalledTimes(1);
  });

  it('lists the history and restores an older version after a confirmation, never the live one', async () => {
    mocks.restoreLandingContentVersion.mockResolvedValue(VERSION(7, {}, 'Restored version 3'));
    mocks.getLandingContent.mockResolvedValue(VIEW(VERSION(5, {}), [VERSION(5, {}), VERSION(3, { hero: { headline: 'Old' } }, 'Saved')]));
    renderScreen();
    expect(await screen.findByText('Live now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore version 5' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore version 3' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    expect(mocks.restoreLandingContentVersion).toHaveBeenCalledWith('3');
  });

  it('shows a load failure with a retry, and does not render a form that could save over nothing', async () => {
    mocks.getLandingContent.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'Server unavailable.', status: 500 }));
    renderScreen();
    expect(await screen.findByText('Server unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});
