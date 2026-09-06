import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { render } from '@testing-library/react';
import { GuestAuthProvider } from '../../auth/GuestAuthContext.jsx';
import { BrandingProvider } from '../../branding/BrandingContext.jsx';

export const PROPERTY_SLUG = 'alpha-hotels';

function PropertyScope() {
  return (
    <BrandingProvider propertySlug={PROPERTY_SLUG}>
      <GuestAuthProvider propertySlug={PROPERTY_SLUG}>
        <Outlet context={{ propertySlug: PROPERTY_SLUG }} />
      </GuestAuthProvider>
    </BrandingProvider>
  );
}

/**
 * Renders a portal screen inside the same nested-route shape `PortalApp.jsx`
 * uses in the real app (`BrandingProvider` + `GuestAuthProvider` around an
 * `Outlet`), so `useOutletContext()`/`useGuestAuth()`/`useBranding()` all
 * resolve exactly as they do there, rather than a screen test having to
 * fake three separate context values by hand.
 *
 * @param {import('react').ReactNode} element   The screen under test.
 * @param {string} [routePath]                  Path (relative to `/portal/:propertySlug`) the screen is mounted at — omit for the index route.
 * @param {string} [initialPath]                Full initial location, including any query string — defaults to `routePath` with no params filled in.
 * @param {Array<{path: string, element: import('react').ReactNode}>} [otherRoutes]   Sibling routes a test needs to assert navigation landed on (e.g. the index route, as a post-login redirect target).
 */
export function renderPortalScreen({ element, routePath, initialPath, otherRoutes = [] }) {
  return render(
    <MemoryRouter initialEntries={[initialPath ?? `/portal/${PROPERTY_SLUG}${routePath ? `/${routePath}` : ''}`]}>
      <Routes>
        <Route path="/portal/:propertySlug" element={<PropertyScope />}>
          {routePath ? <Route path={routePath} element={element} /> : <Route index element={element} />}
          {otherRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
