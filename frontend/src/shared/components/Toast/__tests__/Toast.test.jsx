import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toast } from '../Toast.jsx';

describe('<Toast>', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the message with a check icon (DESIGN_SYSTEM.md §2)', () => {
    render(<Toast message="Check-in complete" />);
    expect(screen.getByText('Check-in complete')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('auto-dismisses after the default ~4s', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Folio posted" onDismiss={onDismiss} />);

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss before its duration elapses', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Rate saved" onDismiss={onDismiss} />);

    vi.advanceTimersByTime(3999);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('announces politely rather than interrupting (role=status)', () => {
    render(<Toast message="Check-in complete" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  // jsdom does not lay out CSS, so a pixel-measurement assertion here would
  // be unreliable rather than a real proof (TESTING.md FE-7's ≥44×44px is a
  // rendered-size guarantee, and Toast.module.css's own use of
  // --control-h-touch on .close is what actually provides it). What IS
  // honestly testable at this level: the dismiss control renders as a real,
  // focusable, labelled button rather than something a keyboard or
  // screen-reader user — or a finger — can't reliably hit at all.
  it('renders the dismiss control as a real, labelled, focusable button', () => {
    render(<Toast message="Check-in complete" onDismiss={() => {}} />);
    const button = screen.getByRole('button', { name: 'Dismiss' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toBeDisabled();
  });
});
