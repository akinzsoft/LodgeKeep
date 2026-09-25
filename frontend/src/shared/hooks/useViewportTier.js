import { useSyncExternalStore } from 'react';

/**
 * The shell's two breakpoints — must stay in step with the CSS: `639px` is the
 * `@media (width <= 639px)` rule in `app/shell/Sidebar.module.css` and
 * `AppShell.module.css`, and `1024px` is DESIGN_SYSTEM.md §1's "Sidebar: full →
 * icon-only at 1024px → off-canvas drawer below 640px". CSS decides how the
 * shell LOOKS at each width; this is the one place JavaScript needs to know
 * them too, because what the sidebar does BY DEFAULT — and whether tapping a
 * menu item should close it — is behaviour, not presentation.
 */
export const PHONE_QUERY = '(max-width: 639px)';
export const TABLET_QUERY = '(max-width: 1024px)';

function matchMediaOrNull(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

function subscribe(onChange) {
  const queries = [matchMediaOrNull(PHONE_QUERY), matchMediaOrNull(TABLET_QUERY)].filter(Boolean);
  queries.forEach((query) => query.addEventListener('change', onChange));
  return () => queries.forEach((query) => query.removeEventListener('change', onChange));
}

function getSnapshot() {
  if (matchMediaOrNull(PHONE_QUERY)?.matches) return 'phone';
  if (matchMediaOrNull(TABLET_QUERY)?.matches) return 'tablet';
  return 'desktop';
}

/**
 * useViewportTier — `'phone'` (below 640px), `'tablet'` (640–1024px, which
 * includes a landscape POS terminal) or `'desktop'` (above 1024px), re-rendering
 * when the viewport crosses a breakpoint (rotating a device, resizing a
 * window). Where `matchMedia` does not exist (a test environment, a very old
 * browser) it answers `'desktop'` — the behaviour every screen already had —
 * rather than throwing.
 */
export function useViewportTier() {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'desktop');
}
