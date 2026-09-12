import { MemoryRouter, Routes, Route, Outlet, useParams } from 'react-router-dom';
import { render } from '@testing-library/react';

export const TOKEN = 'test-raw-token-value';

/**
 * Renders a QR-order screen inside the same nested-route shape
 * `QrOrderApp.jsx` uses in the real app — `useOutletContext()` resolves
 * `{token}` exactly as it does there, matching `portal/screens/__tests__/renderPortalScreen.jsx`'s
 * own precedent for the sibling anonymous app.
 */
function TokenScope() {
  const { token } = useParams();
  return <Outlet context={{ token }} />;
}

/**
 * @param {import('react').ReactNode} element   The screen under test.
 * @param {string} [routePath]                  Path (relative to `/qr-order/:token`) the screen is mounted at.
 * @param {string} [initialPath]                Full initial location, including any query string / router state caller.
 * @param {Array<{path: string, element: import('react').ReactNode}>} [otherRoutes]   Sibling routes a test needs to assert navigation landed on.
 */
export function renderQrOrderScreen({ element, routePath, initialPath, otherRoutes = [] }) {
  return render(
    <MemoryRouter initialEntries={[initialPath ?? { pathname: `/qr-order/${TOKEN}${routePath ? `/${routePath}` : ''}` }]}>
      <Routes>
        <Route path="/qr-order/:token" element={<TokenScope />}>
          {routePath ? <Route path={routePath} element={element} /> : <Route index element={element} />}
          {otherRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
