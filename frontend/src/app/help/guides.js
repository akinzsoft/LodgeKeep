/**
 * The Help guides are markdown files under `content/`, bundled as raw text
 * (no fetch, so they work offline once the app has loaded). A guide's slug is
 * its path under `content/` without the extension, e.g.
 * `getting-started/01-property` or `common-problems/tax-missing-or-wrong`.
 */
import { parseFrontmatter } from './frontmatter.js';

const files = import.meta.glob('./content/**/*.md', { query: '?raw', import: 'default', eager: true });

function titleOf(source, slug) {
  const match = /^#\s+(.+)$/m.exec(source);
  return match ? match[1].trim() : slug;
}

export const GUIDES = Object.fromEntries(
  Object.entries(files).map(([path, raw]) => {
    const slug = path.replace('./content/', '').replace(/\.md$/, '');
    const { data, body, problems } = parseFrontmatter(raw);
    return [slug, { slug, title: titleOf(body, slug), source: body, video: data.video, videoTitle: data.videoTitle, images: data.images, problems }];
  }),
);

export function getGuide(slug) {
  return GUIDES[slug] ?? null;
}

export function listGuides(section) {
  return Object.values(GUIDES)
    .filter((guide) => guide.slug.startsWith(`${section}/`))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
