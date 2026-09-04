import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// globals:false (vite.config.js) means Testing Library's own automatic
// afterEach(cleanup) registration — which looks for an ambient global — never
// fires. Without this, a component rendered in one test is still in the DOM
// for the next one, and queries like getByRole start finding duplicates.
afterEach(() => {
  cleanup();
});
