import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { content as defaults } from '../landingContent.js';
import { CONTENT_WAIT_MS } from '../useLandingContent.js';
import LandingApp from '../LandingApp.jsx';

const mocks = vi.hoisted(() => ({ getPublicLandingContent: vi.fn() }));

vi.mock('../../shared/api/index.js', async () => {
  const actual = await vi.importActual('../../shared/api/index.js');
  return { ...actual, landingApi: mocks };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => mocks.getPublicLandingContent.mockReset());

describe('the landing page with live content', () => {
  it('shows saved text, the LIVE monthly fee and trial length, and the saved contact details', async () => {
    mocks.getPublicLandingContent.mockResolvedValue({
      overrides: { hero: { headline: 'Brand new headline' }, contact: { whatsapp: '2348011112222', email: '', phone: '' }, pricing: { setupAmount: '' } },
      monthly: { amount: '41000.00', currency: 'NGN', interval: 'monthly' },
      trialDays: 30,
    });
    render(<LandingApp />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Brand new headline');
    expect(screen.getByText(/41,000\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/35,000\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/30-day free trial/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/one-time setup fee/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /whatsapp/i }).getAttribute('href')).toContain('2348011112222');
    expect(screen.queryByRole('link', { name: /email/i })).not.toBeInTheDocument();
  });

  it('holds the editable sections back until the content arrives, so nothing flashes and changes', async () => {
    let resolve;
    mocks.getPublicLandingContent.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<LandingApp />);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText(/35,000\.00/)).not.toBeInTheDocument();
    await act(async () => resolve({ overrides: {}, monthly: { amount: '35000.00', currency: 'NGN', interval: 'monthly' }, trialDays: 14 }));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('falls back to the built-in defaults when the request fails', async () => {
    mocks.getPublicLandingContent.mockRejectedValueOnce(new Error('offline'));
    render(<LandingApp />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/hotel, bar and mini.mart/i);
    expect(screen.getByText(/35,000\.00/)).toBeInTheDocument();
  });

  it('falls back to the defaults if the request is too slow, and ignores a late answer', async () => {
    vi.useFakeTimers();
    let resolve;
    mocks.getPublicLandingContent.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<LandingApp />);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(CONTENT_WAIT_MS + 10));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(defaults.hero.headline.replace('‑', '‑'));
    await act(async () => resolve({ overrides: { hero: { headline: 'Too late' } }, trialDays: 14 }));
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('Too late');
  });

  it('renders saved text as plain text, never as HTML', async () => {
    mocks.getPublicLandingContent.mockResolvedValue({ overrides: { hero: { headline: '<img src=x onerror=alert(1)> Hello' } }, trialDays: 14 });
    const { container } = render(<LandingApp />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('<img src=x onerror=alert(1)> Hello');
    expect(container.querySelector('h1 img')).toBeNull();
  });
});
