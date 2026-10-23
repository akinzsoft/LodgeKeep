/**
 * The Help guides are markdown files under `content/`, bundled as raw text
 * (no fetch, so they work offline once the app has loaded). A guide's slug is
 * its path under `content/` without the extension, e.g.
 * `getting-started/01-property` or `common-problems/tax-missing-or-wrong`.
 */
const files = import.meta.glob('./content/**/*.md', { query: '?raw', import: 'default', eager: true });

function titleOf(source, slug) {
  const match = /^#\s+(.+)$/m.exec(source);
  return match ? match[1].trim() : slug;
}

export const GUIDES = Object.fromEntries(
  Object.entries(files).map(([path, source]) => {
    const slug = path.replace('./content/', '').replace(/\.md$/, '');
    return [slug, { slug, title: titleOf(source, slug), source }];
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
