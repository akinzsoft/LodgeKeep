import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// globals:false (vite.config.js) means Testing Library's own automatic
// afterEach(cleanup) registration — which looks for an ambient global — never
// fires. Without this, a component rendered in one test is still in the DOM
// for the next one, and queries like getByRole start finding duplicates.
afterEach(() => {
  cleanup();
});

// findBy*/waitFor give up after 1s by default, while each test itself may run
// for 5s (Vitest's testTimeout). On a loaded CI runner a screen that loads
// several mocked lists before rendering (MenuItemsTab, StockItemsTab) could
// need more than that 1s and fail with "Unable to find" while the test still
// had 4s left — reproduced with every CPU core saturated: the items card was
// still showing its loading skeleton, not a wrong result. Waiting up to 3s
// keeps a real failure well inside the test's own timeout.
configure({ asyncUtilTimeout: 3000 });
