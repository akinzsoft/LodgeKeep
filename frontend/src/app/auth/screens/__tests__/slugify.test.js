import { describe, it, expect } from 'vitest';
import { slugify } from '../slugify.js';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Riverside Hotels')).toBe('riverside-hotels');
  });

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('Riverside & Sons Hotels!!')).toBe('riverside-sons-hotels');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  -Riverside-  ')).toBe('riverside');
  });
});
