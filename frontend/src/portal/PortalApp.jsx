import { BrowserRouter, Routes, Route, Outlet, useParams } from 'react-router-dom';
import { GuestAuthProvider } from './auth/GuestAuthContext.jsx';
import { BrandingProvider } from './branding/BrandingContext.jsx';
import { PropertyLandingScreen } from './screens/PropertyLandingScreen.jsx';
import { AvailabilitySearchScreen } from './screens/AvailabilitySearchScreen.jsx';
import { BookingCheckoutScreen } from './screens/BookingCheckoutScreen.jsx';
import { ConfirmationScreen } from './screens/ConfirmationScreen.jsx';
import { LoginScreen } from './screens/LoginScreen.jsx';
import { RegisterScreen } from './screens/RegisterScreen.jsx';
import { AccountBookingsScreen } from './screens/AccountBookingsScreen.jsx';

/**
 * PortalApp — PLAN.md Phase 4, the guest booking portal
 * (PRODUCT_REQUIREMENTS.md §3.14/§3.16). Mounted by `main.jsx`'s own
 * pathname fork (`window.location.pathname.startsWith('/portal')`) instead
 * of the staff `<AuthProvider><Demo/></AuthProvider>` tree — the two are
 * never mounted together in one page load, which is also what makes
 * reusing `shared/api/client.js`'s single token/refresh-handler registration
 * safe for both (`GuestAuthContext`'s own header explains this).
 *
 * `react-router-dom` is scoped to this directory alone — nothing under
 * `src/app/*` imports it, and the staff app keeps its existing router-free
 * `activeItemKey`-switch approach untouched.
 *
 * Routed as `/portal/:propertySlug/...` — a tenant may run several
 * properties, and `guestLogin`/`guestRegister` (backend) both already take
 * a `property_slug`, so the portal needs the same addressing.
 */
export function PortalApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/portal/:propertySlug" element={<PropertyScope />}>
          <Route index element={<PropertyLandingScreen />} />
          <Route path="search" element={<AvailabilitySearchScreen />} />
          <Route path="book" element={<BookingCheckoutScreen />} />
          <Route path="confirmation/:confirmationNumber" element={<ConfirmationScreen />} />
          <Route path="login" element={<LoginScreen />} />
          <Route path="register" element={<RegisterScreen />} />
          <Route path="account/bookings" element={<AccountBookingsScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function PropertyScope() {
  const { propertySlug } = useParams();
  return (
    <BrandingProvider propertySlug={propertySlug}>
      <GuestAuthProvider propertySlug={propertySlug}>
        <Outlet context={{ propertySlug }} />
      </GuestAuthProvider>
    </BrandingProvider>
  );
}
