import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';

// A new deploy must reach devices that stay open all day (a bar tablet, the
// store's desktop): the app compares the build it is running with the one
// the server now serves (`/version.json`) and offers a reload when they
// differ (`shared/hooks/useNewVersionAvailable.js`). One id per build —
// `APP_BUILD_ID` when the build supplies one, otherwise the build's own
// timestamp. Docker's layer cache reuses an unchanged build, so an unchanged
// frontend keeps its id and never prompts.
const BUILD_ID = process.env.APP_BUILD_ID || new Date().toISOString();

/** Writes `dist/version.json` (`{buildId}`) next to index.html on `vite build`. */
function versionFile() {
  return {
    name: 'lodgekeep-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

// Vitest config lives in the same file (Vite's own recommended pattern) so
// dev/build/test all share one module-resolution setup — no separate config
// to drift from this one.
export default defineConfig({
  plugins: [react(), versionFile()],
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(BUILD_ID),
  },
  server: {
    // `shared/api/client.js` calls relative paths ("/api/v1/..."), which the
    // dev server needs somewhere real to go — the backend
    // (`backend/src/server.js`, PORT from backend/.env.example, default
    // 3000). `changeOrigin` must be explicitly `false`: the backend's tenant
    // resolution (`src/auth/tenant-resolution.js`) reads the request's Host
    // header, and this dev server is visited at `alpha-hotels.localhost:5173`
    // / `beta-resorts.localhost:5173` — with `changeOrigin: true` that header
    // is rewritten to the proxy target's own host and every request stops
    // resolving a tenant at all.
    //
    // This MUST be the object form, not the `'/api': 'http://localhost:3000'`
    // string shorthand: Vite's proxy middleware
    // (`node_modules/vite/dist/node/chunks/node.js`, `proxyMiddleware`)
    // silently substitutes `{ target: <string>, changeOrigin: true }` for a
    // string value, regardless of any stated "false is the default" — the
    // shorthand form has no way to turn that off. Confirmed live: with the
    // shorthand, the backend received `Host: localhost:3000` (the proxy
    // target) instead of the browser's original `alpha-hotels.localhost:5173`,
    // and every proxied login 404'd as an unresolved tenant.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    css: true,
    globals: false,
  },
});
