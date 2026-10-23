import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { GuideMedia } from '../GuideMedia.jsx';

const IMAGES = [
  { file: 'g/1.webp', alt: 'First screen', caption: 'Step one' },
  { file: 'g/2.webp', alt: 'Second screen' },
];

describe('GuideMedia', () => {
  it('renders nothing when there is no media', () => {
    const { container } = render(<GuideMedia images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lazy-loads images with alt text and captions', () => {
    render(<GuideMedia images={IMAGES} />);
    const first = screen.getByAltText('First screen');
    expect(first).toHaveAttribute('src', '/help/images/g/1.webp');
    expect(first).toHaveAttribute('loading', 'lazy');
    expect(screen.getByText('Step one')).toBeInTheDocument();
  });

  it('opens an image larger and closes it with the button and with Escape', async () => {
    const user = userEvent.setup();
    render(<GuideMedia images={IMAGES} />);
    await user.click(screen.getByRole('button', { name: 'Enlarge: First screen' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enlarge: Second screen' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves out a picture that has not been captured yet', () => {
    render(<GuideMedia images={IMAGES} />);
    fireEvent.error(screen.getByAltText('First screen'));
    expect(screen.queryByAltText('First screen')).toBeNull();
    expect(screen.getByAltText('Second screen')).toBeInTheDocument();
  });

  it('loads nothing from the video host until play is pressed', async () => {
    const user = userEvent.setup();
    const { container } = render(<GuideMedia video="https://www.youtube.com/watch?v=abc123" videoTitle="Rooms" />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText(/Nothing is loaded from YouTube until you press play/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Play video: Rooms/ }));
    const frame = container.querySelector('iframe');
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abc123?autoplay=1');
    expect(frame).toHaveAttribute('title', 'Rooms');
  });

  it('plays a direct mp4 in a video element only after play', async () => {
    const user = userEvent.setup();
    const { container } = render(<GuideMedia video="https://cdn.example.com/a.mp4" />);
    expect(container.querySelector('video')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Play video/ }));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://cdn.example.com/a.mp4');
  });

  it('ignores a video URL it does not recognise', () => {
    const { container } = render(<GuideMedia video="https://evil.example.com/x" images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
