/** Up to two initials for an avatar: "Emily Smith" → "ES", "Ada" → "A", "manager@x.com" → "M". */
export function initialsFor(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1 || words[0].includes('@')) return words[0].charAt(0).toUpperCase();
  return `${words[0].charAt(0)}${words[words.length - 1].charAt(0)}`.toUpperCase();
}
