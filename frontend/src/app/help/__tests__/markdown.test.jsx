import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Markdown, parseMarkdown } from '../markdown.jsx';

describe('parseMarkdown', () => {
  it('splits headings, paragraphs and lists', () => {
    expect(parseMarkdown('# T\n\nline one\nline two\n\n1. a\n2. b\n\n- x')).toEqual([
      { type: 'h1', text: 'T' }, { type: 'p', text: 'line one line two' },
      { type: 'ol', items: ['a', 'b'] }, { type: 'ul', items: ['x'] },
    ]);
  });
});

describe('Markdown', () => {
  it('renders formatting and never raw HTML', () => {
    const { container } = render(<Markdown source={'**bold** `code` <script>x</script>'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(container.querySelector('script')).toBeNull();
  });
  it('routes help: links in the app, opens https links safely, and drops other links', async () => {
    const onOpenGuide = vi.fn();
    render(<Markdown source={'[a](help:x/y) [b](https://example.com) [c](javascript:alert(1))'} onOpenGuide={onOpenGuide} />);
    await userEvent.click(screen.getByRole('link', { name: 'a' }));
    expect(onOpenGuide).toHaveBeenCalledWith('x/y');
    expect(screen.getByRole('link', { name: 'b' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'c' })).toBeNull();
  });
});
