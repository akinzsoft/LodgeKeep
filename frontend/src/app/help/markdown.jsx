import { Fragment } from 'react';

/**
 * A deliberately tiny markdown renderer for the Help guides — headings,
 * paragraphs, bullet and numbered lists, bold, inline code and links. The
 * guides are our own files, but it still builds React elements (never HTML
 * strings), so nothing a guide contains can inject markup.
 *
 * Links: `help:<guide-slug>` opens another guide in the app (via `onOpenGuide`);
 * `https://…` opens in a new tab; anything else renders as plain text.
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text, onOpenGuide, keyPrefix) {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, target] = link;
      if (target.startsWith('help:')) {
        const slug = target.slice('help:'.length);
        return (
          <a
            key={key}
            href={`#${slug}`}
            onClick={(event) => {
              event.preventDefault();
              onOpenGuide?.(slug);
            }}
          >
            {label}
          </a>
        );
      }
      if (/^https:\/\//.test(target)) {
        return (
          <a key={key} href={target} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        );
      }
      return <Fragment key={key}>{label}</Fragment>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/** Splits markdown into blocks: `{type: 'h1'|'h2'|'h3'|'p'|'ul'|'ol', text | items}`. */
export function parseMarkdown(source) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2] });
    } else if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list = list ?? { type, items: [] };
      list.items.push((bullet ?? numbered)[1]);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function Markdown({ source, onOpenGuide }) {
  return parseMarkdown(source).map((block, index) => {
    const key = `b${index}`;
    if (block.type === 'ul' || block.type === 'ol') {
      const Tag = block.type;
      return (
        <Tag key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, onOpenGuide, `${key}-${itemIndex}`)}</li>
          ))}
        </Tag>
      );
    }
    const Tag = block.type === 'p' ? 'p' : block.type;
    return <Tag key={key}>{renderInline(block.text, onOpenGuide, key)}</Tag>;
  });
}
