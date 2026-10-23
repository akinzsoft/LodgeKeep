import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { GUIDES } from '../guides.js';

// Help images live in the repo, so they stay small: webp only, 300 KB at most, and
// no video or other large file is ever committed (host videos and link them).
const ROOT = join(cwd(), 'public', 'help');
const MAX_BYTES = 300 * 1024;

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe('help images', () => {
  const files = filesUnder(ROOT);

  it('keeps every file under public/help a webp image of 300 KB or less', () => {
    for (const file of files) {
      expect(file.endsWith('.webp'), `${file} must be .webp`).toBe(true);
      expect(statSync(file).size, `${file} is over 300 KB`).toBeLessThanOrEqual(MAX_BYTES);
    }
  });

  it('has a file for every image a guide lists', () => {
    for (const guide of Object.values(GUIDES)) {
      for (const image of guide.images) {
        expect(existsSync(join(ROOT, 'images', image.file)), `${guide.slug}: ${image.file}`).toBe(true);
      }
    }
  });

  it('has no front matter problems in any guide', () => {
    for (const guide of Object.values(GUIDES)) expect(guide.problems, guide.slug).toEqual([]);
  });
});
