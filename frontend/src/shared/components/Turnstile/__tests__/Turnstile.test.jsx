import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Turnstile } from '../Turnstile.jsx';

const mocks = vi.hoisted(() => ({ loadTurnstile: vi.fn() }));

vi.mock('../../../turnstile.js', () => ({ loadTurnstile: mocks.loadTurnstile }));

describe('<Turnstile>', () => {
  let fakeTurnstile;

  beforeEach(() => {
    fakeTurnstile = { render: vi.fn(() => 'widget-1'), remove: vi.fn() };
    mocks.loadTurnstile.mockReset().mockResolvedValue(fakeTurnstile);
  });

  it('renders the real widget against its own container, with the given site key', async () => {
    render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={vi.fn()} />);

    await waitFor(() => expect(fakeTurnstile.render).toHaveBeenCalled());
    const [container, options] = fakeTurnstile.render.mock.calls[0];
    expect(container.tagName).toBe('DIV');
    expect(options.sitekey).toBe('1x00000000000000000000AA');
  });

  it('calls onVerify with the real token when Turnstile\'s own callback fires', async () => {
    const onVerify = vi.fn();
    render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={onVerify} />);
    await waitFor(() => expect(fakeTurnstile.render).toHaveBeenCalled());

    const options = fakeTurnstile.render.mock.calls[0][1];
    options.callback('a-real-response-token');

    expect(onVerify).toHaveBeenCalledWith('a-real-response-token');
  });

  it('calls onExpire when Turnstile\'s own expired-callback fires', async () => {
    const onExpire = vi.fn();
    render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={vi.fn()} onExpire={onExpire} />);
    await waitFor(() => expect(fakeTurnstile.render).toHaveBeenCalled());

    fakeTurnstile.render.mock.calls[0][1]['expired-callback']();

    expect(onExpire).toHaveBeenCalled();
  });

  it('calls onError when Turnstile\'s own error-callback fires', async () => {
    const onError = vi.fn();
    render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={vi.fn()} onError={onError} />);
    await waitFor(() => expect(fakeTurnstile.render).toHaveBeenCalled());

    fakeTurnstile.render.mock.calls[0][1]['error-callback']();

    expect(onError).toHaveBeenCalled();
  });

  it('calls onError if the Turnstile script itself fails to load', async () => {
    mocks.loadTurnstile.mockReset().mockRejectedValue(new Error('script blocked'));
    const onError = vi.fn();
    render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={vi.fn()} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('removes the widget on unmount', async () => {
    window.turnstile = fakeTurnstile;
    const { unmount } = render(<Turnstile siteKey="1x00000000000000000000AA" onVerify={vi.fn()} />);
    await waitFor(() => expect(fakeTurnstile.render).toHaveBeenCalled());

    unmount();

    expect(fakeTurnstile.remove).toHaveBeenCalledWith('widget-1');
    delete window.turnstile;
  });
});
