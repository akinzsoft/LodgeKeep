# syntax=docker/dockerfile:1

################################################################################
# Stage: deps — install production dependencies only.
#
# Base: node:20-bookworm-slim (Debian glibc), deliberately NOT an
# alpine/musl image. bcrypt@^6.0.0 (the one native dependency in this
# codebase) ships prebuilt N-API binaries via `prebuildify --tag-libc`; a
# matching musl prebuild for the installed version was not independently
# confirmed, and a silent Alpine fallback to compiling from source would
# also need python3/make/g++ this slim base doesn't carry. glibc removes
# that risk outright at a modest image-size cost.
#
# package.json's engines field is ">=20" — this pins to the same major
# version CI already tests the backend against (.github/workflows/ci.yml).
#
# Security-review finding: `node:20-bookworm-slim` is a moving tag — pinned
# by digest instead so a plain `docker build` is reproducible and never
# silently pulls in an unreviewed image. Bump deliberately (`docker pull
# node:20-bookworm-slim && docker inspect --format='{{index .RepoDigests 0}}' node:20-bookworm-slim`)
# — Dependabot (`.github/dependabot.yml`) also opens a PR automatically
# when a newer digest is available.
################################################################################
FROM node:26-bookworm-slim@sha256:c8fedd782bcd1b68d8a7d1ed2577b5f820eba820871323f605292651ff11e3c6 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Network access to BOTH registry.npmjs.org and cdn.sheetjs.com is required
# here — the `xlsx` dependency resolves from a direct CDN tarball URL, not
# the npm registry (see package.json's own dependencies block).
RUN npm ci --omit=dev

################################################################################
# Stage: runtime
################################################################################
FROM node:26-bookworm-slim@sha256:c8fedd782bcd1b68d8a7d1ed2577b5f820eba820871323f605292651ff11e3c6 AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY knexfile.js ./
COPY src ./src
COPY migrations ./migrations
COPY seeds ./seeds

# Every local-disk storage path (src/shared/image-store.js,
# src/jobs/tenant-data-export.js, src/modules/migration/storage.js) is
# created lazily on first write via fs.mkdirSync(dir, {recursive:true}) —
# pre-created here only so the non-root user below already owns a writable
# parent and docker-compose.prod.yml's four named volumes have a real
# mount point to attach onto.
RUN mkdir -p storage/exports storage/imports storage/menu-images storage/property-logos \
    && chown -R node:node /app

# node:20-bookworm-slim already defines a `node` user/group (uid/gid 1000) —
# the official Node image's own convention, not created here.
USER node
EXPOSE 3000

# GET /healthz (src/shared/health.js) is the first health-check endpoint
# this backend has ever had — mounted ahead of every router, auth, and
# tenant resolution, and checks real MySQL connectivity, not just "the
# process is listening." No curl dependency added to the slim base — Node
# itself makes the request.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# All 9 BullMQ workers/schedulers (src/jobs/queues.js) start in-process
# inside src/server.js — there is no separate worker process or command.
CMD ["node", "src/server.js"]
