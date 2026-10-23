import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseVideoUrl } from '../frontmatter.js';

const GUIDE = `---
video: https://youtu.be/abc_123-X
video_title: "Setting up rooms"
images:
  - file: getting-started/02/1-types.webp
    alt: The Room Types tab
    caption: Setup → Room Types
  - file: getting-started/02/2-rooms.webp
    alt: The Rooms tab
---
# Title

Body`;

describe('parseFrontmatter', () => {
  it('reads video, title and images, and returns the body without the block', () => {
    const { data, body, problems } = parseFrontmatter(GUIDE);
    expect(problems).toEqual([]);
    expect(data.video).toBe('https://youtu.be/abc_123-X');
    expect(data.videoTitle).toBe('Setting up rooms');
    expect(data.images).toEqual([
      { file: 'getting-started/02/1-types.webp', alt: 'The Room Types tab', caption: 'Setup → Room Types' },
      { file: 'getting-started/02/2-rooms.webp', alt: 'The Rooms tab' },
    ]);
    expect(body).toBe('# Title\n\nBody');
  });

  it('treats a guide with no front matter as all body, with no media', () => {
    expect(parseFrontmatter('# Hi')).toEqual({ data: { images: [] }, body: '# Hi', problems: [] });
  });

  it('accepts partial front matter', () => {
    expect(parseFrontmatter('---\nvideo_title: Only a title\n---\nx').data).toEqual({ videoTitle: 'Only a title', images: [] });
  });

  it('drops unsafe or malformed values and says why', () => {
    const { data, problems } = parseFrontmatter(`---
video: javascript:alert(1)
images:
  - file: ../../etc/passwd.webp
    alt: x
  - file: shot.png
    alt: x
  - file: ok/shot.webp
  - file: ok/fine.webp
    alt: Fine
nonsense line
---
x`);
    expect(data.video).toBeUndefined();
    expect(data.images).toEqual([{ file: 'ok/fine.webp', alt: 'Fine' }]);
    expect(problems).toHaveLength(5);
  });

  it('leaves a document that merely contains --- later alone', () => {
    const text = '# Title\n\n---\nnot front matter\n---\n';
    expect(parseFrontmatter(text).body).toBe(text);
  });
});

describe('parseVideoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc123', 'https://www.youtube-nocookie.com/embed/abc123'],
    ['https://youtu.be/abc123', 'https://www.youtube-nocookie.com/embed/abc123'],
    ['https://vimeo.com/123456', 'https://player.vimeo.com/video/123456'],
    ['https://www.loom.com/share/abcdef123', 'https://www.loom.com/embed/abcdef123'],
    ['https://iframe.videodelivery.net/abc123', 'https://iframe.videodelivery.net/abc123'],
    ['https://customer-xyz.cloudflarestream.com/abc123/watch', 'https://customer-xyz.cloudflarestream.com/abc123/iframe'],
  ])('embeds %s', (input, src) => {
    expect(parseVideoUrl(input)).toMatchObject({ kind: 'embed', src });
  });

  it('plays a direct https mp4 as a file', () => {
    expect(parseVideoUrl('https://cdn.example.com/a/b.mp4')).toMatchObject({ kind: 'file', src: 'https://cdn.example.com/a/b.mp4' });
  });

  it.each(['http://youtu.be/abc', 'https://evil.example.com/watch?v=abc', 'https://www.youtube.com/watch?v=a"b', 'https://vimeo.com/notnumeric', 'not a url', 'https://example.com/clip.webm', 'javascript:alert(1)'])('refuses %s', (input) => {
    expect(parseVideoUrl(input)).toBeNull();
  });
});
