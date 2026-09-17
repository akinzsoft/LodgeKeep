# syntax=docker/dockerfile:1
#
# Build context for this file is the REPO ROOT (see docker-compose.prod.yml's
# `frontend.build.context: .`), not frontend/ — it needs both frontend/ and
# this file's own sibling Caddyfile.

################################################################################
# Stage: build — compiles the Vite production bundle.
#
# Node 22, not 20: frontend/package.json's own `engines` field requires
# ^22.22.2 || ^24.15.0 || >=26.0.0 — strictly newer than the backend's
# >=20 (confirmed: node:22-bookworm-slim resolves to v22.23.2, which
# satisfies ^22.22.2). This is exactly the point of building the frontend
# as its own separate stage/image: the heavy Vite build (and its memory
# spike) happens here, on a throwaway layer, and never touches the image
# that actually runs on the production box (the "caddy" stage below).
################################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

################################################################################
# Stage: caddy — serves the built static bundle and reverse-proxies /api/*
# to the backend. This is the only stage that ends up running on the
# production box; everything above it is discarded once the build finishes.
#
# Vite's default build.outDir is `dist/` (no override in
# frontend/vite.config.js) — that's what's copied below.
#
# Pinned to the exact minor version this Caddyfile was validated against
# (`caddy validate`), not a bare `caddy:2-alpine` — this config is genuinely
# version-sensitive: `on_demand_tls`'s `interval`/`burst` sub-directives,
# present in earlier Caddy 2.x releases, are rejected outright by 2.11
# ("no longer supported"), which `caddy validate` caught directly against
# this image before this Dockerfile settled on its current shape. A future
# `docker build` pulling a newer/older untested 2.x could reintroduce a
# config-validation failure at container start; bump this deliberately,
# re-running `caddy validate` against the new tag, rather than drifting on it.
################################################################################
FROM caddy:2.11-alpine
COPY --from=build /app/dist /srv
COPY docker/frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
