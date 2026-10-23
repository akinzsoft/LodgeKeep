/**
 * Guide front matter — a small, strict subset of YAML (no dependency):
 *
 *   ---
 *   video: https://www.youtube.com/watch?v=abc123
 *   video_title: Setting up rooms
 *   images:
 *     - file: getting-started/02-rooms-and-rates/1-room-types.webp
 *       alt: The Room Types tab with one type listed
 *       caption: Add each type once
 *   ---
 *
 * Everything is optional. A bad value is dropped (never rendered) and
 * reported in `problems`, so a typo in a guide cannot break the page or smuggle
 * in an unsafe URL.
 */
const IMAGE_FILE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.webp$/;

function unquote(value) {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/** @returns {{data: {video?: string, videoTitle?: string, images: {file: string, alt: string, caption?: string}[]}, body: string, problems: string[]}} */
export function parseFrontmatter(source) {
  const problems = [];
  const empty = { data: { images: [] }, body: source, problems };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return empty;

  const body = source.slice(match[0].length);
  const raw = { images: [] };
  let inImages = false;
  let current = null;

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      inImages = top[1] === 'images';
      current = null;
      if (!inImages) raw[top[1]] = unquote(top[2]);
      continue;
    }
    const item = /^\s+-\s+([a-z_]+):\s*(.*)$/.exec(line);
    const field = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (inImages && item) {
      current = { [item[1]]: unquote(item[2]) };
      raw.images.push(current);
    } else if (inImages && field && current) {
      current[field[1]] = unquote(field[2]);
    } else {
      problems.push(`Unreadable front matter line: ${line.trim()}`);
    }
  }

  const data = { images: [] };
  if (raw.video) {
    if (parseVideoUrl(raw.video)) data.video = raw.video;
    else problems.push(`Unsupported video URL: ${raw.video}`);
  }
  if (raw.video_title) data.videoTitle = raw.video_title;
  for (const image of raw.images) {
    if (!image.file || !IMAGE_FILE.test(image.file) || image.file.includes('..')) {
      problems.push(`Invalid image file: ${image.file ?? '(missing)'}`);
    } else if (!image.alt) {
      problems.push(`Image ${image.file} needs alt text`);
    } else {
      data.images.push({ file: image.file, alt: image.alt, ...(image.caption ? { caption: image.caption } : {}) });
    }
  }
  return { data, body, problems };
}

/**
 * Where a guide video plays: an embeddable player URL for a known provider, or
 * a direct file. Anything else (http, other hosts, javascript:) is null.
 * @returns {{kind: 'embed'|'file', provider: string, src: string} | null}
 */
export function parseVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const id = (text) => (text && /^[A-Za-z0-9_-]+$/.test(text) ? text : null);

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const videoId = id(url.pathname.startsWith('/embed/') ? url.pathname.split('/')[2] : url.searchParams.get('v'));
    return videoId ? { kind: 'embed', provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${videoId}` } : null;
  }
  if (host === 'youtu.be') {
    const videoId = id(url.pathname.slice(1));
    return videoId ? { kind: 'embed', provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${videoId}` } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const videoId = /^\d+$/.test(url.pathname.split('/').filter(Boolean).pop() ?? '') ? url.pathname.split('/').filter(Boolean).pop() : null;
    return videoId ? { kind: 'embed', provider: 'Vimeo', src: `https://player.vimeo.com/video/${videoId}` } : null;
  }
  if (host === 'loom.com') {
    const [kind, videoId] = url.pathname.split('/').filter(Boolean);
    return (kind === 'share' || kind === 'embed') && id(videoId) ? { kind: 'embed', provider: 'Loom', src: `https://www.loom.com/embed/${videoId}` } : null;
  }
  if (host === 'iframe.videodelivery.net') {
    const videoId = id(url.pathname.split('/').filter(Boolean)[0]);
    return videoId ? { kind: 'embed', provider: 'Cloudflare Stream', src: `https://iframe.videodelivery.net/${videoId}` } : null;
  }
  if (host.endsWith('.cloudflarestream.com') && host.startsWith('customer-')) {
    const videoId = id(url.pathname.split('/').filter(Boolean)[0]);
    return videoId ? { kind: 'embed', provider: 'Cloudflare Stream', src: `https://${url.hostname}/${videoId}/iframe` } : null;
  }
  if (/\.mp4$/i.test(url.pathname)) return { kind: 'file', provider: 'Video', src: url.toString() };
  return null;
}
