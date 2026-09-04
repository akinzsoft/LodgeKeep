import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vitest config lives in the same file (Vite's own recommended pattern) so
// dev/build/test all share one module-resolution setup — no separate config
// to drift from this one.
export default defineConfig({
  plugins: [react()],
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
