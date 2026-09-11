import { BrowserRouter, Routes, Route, Outlet, Navigate, useParams } from 'react-router-dom';
import { QrOrderBrandingProvider } from './branding/QrOrderBrandingProvider.jsx';
import { MenuScreen } from './screens/MenuScreen.jsx';
import { CheckoutScreen } from './screens/CheckoutScreen.jsx';
import { RoomChargeConfirmScreen } from './screens/RoomChargeConfirmScreen.jsx';
import { OrderStatusScreen } from './screens/OrderStatusScreen.jsx';

/**
 * QrOrderApp — PLAN.md Phase 6's QR self-ordering gap closure
 * (PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section). Mounted by
 * `main.jsx`'s own pathname fork (`window.location.pathname.startsWith('/qr-order')`),
 * a third tree alongside the staff app and `PortalApp` — never mounted
 * together in one page load, the same reasoning `PortalApp.jsx`'s own header
 * gives for why that matters beyond routing (it's what makes reusing
 * `shared/api/client.js`'s module-level singletons safe). This tree needs
 * none of that machinery at all, though — every QR-order route is fully
 * anonymous (`qr-ordering.js`'s own header), so no auth context of any kind
 * is registered here.
 *
 * Routed as `/qr-order/:token/...` — the real backend's own
 * `renderTokenQrImage` (`backend/src/modules/qr-ordering/tokens.js`) encodes
 * exactly `{baseUrl}/{rawToken}/menu` into the printed QR code, so a real
 * scan always lands on the `menu` route with a real raw token in the path.
 * `react-router-dom` is scoped to this directory alone, the same "the staff
 * app keeps its existing router-free approach untouched" precedent
 * `PortalApp.jsx` already established for its own routed subtree.
 */
export function QrOrderApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/qr-order/:token" element={<TokenScope />}>
          <Route index element={<Navigate to="menu" replace />} />
          <Route path="menu" element={<MenuScreen />} />
          <Route path="checkout" element={<CheckoutScreen />} />
          <Route path="orders/:id/room-charge" element={<RoomChargeConfirmScreen />} />
          <Route path="orders/:id/status" element={<OrderStatusScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function TokenScope() {
  const { token } = useParams();
  return (
    <QrOrderBrandingProvider>
      <Outlet context={{ token }} />
    </QrOrderBrandingProvider>
  );
}
