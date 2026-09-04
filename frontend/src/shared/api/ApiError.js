/**
 * ApiError — the one shape every failure from `shared/api` takes, mirroring
 * the backend's own envelope (API.md §2): `code`, `message`, `details`,
 * `requestId`. `status` is the HTTP status the response actually carried, so
 * a caller can branch on it without re-deriving it from `code`.
 *
 * `code: 'NETWORK_ERROR'` is this file's own addition, for the one failure
 * mode that never reaches the backend's envelope at all — the request never
 * got a response (DESIGN_SYSTEM.md §2's offline/degraded state, ARCHITECTURE.md
 * §7's "never silently queue a payment as though it succeeded": a network
 * failure must surface as a real, typed error, not be swallowed or mistaken
 * for a server-shaped one).
 */
export class ApiError extends Error {
  constructor({ code, message, details = null, requestId = null, status = null }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.status = status;
  }
}
