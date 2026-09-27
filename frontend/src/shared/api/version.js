/**
 * The build the server is serving right now — `/version.json`, written next
 * to index.html by `vite build` (vite.config.js). A plain static file, not an
 * `/api/v1` call: no auth, no tenant, no envelope, and `no-store` plus a
 * throwaway query so neither the browser nor a proxy can answer from cache.
 *
 * @returns {Promise<string|null>} the deployed build id, or null when it
 *   cannot be read (dev server, offline, a half-finished deploy).
 */
export async function fetchDeployedBuildId() {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.buildId === 'string' ? body.buildId : null;
  } catch {
    return null;
  }
}
