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
#
# Security-review finding: `node:22-bookworm-slim` is a moving tag — pinned
# by digest instead so a plain `docker build` is reproducible. Bump
# deliberately (re-confirm the `^22.22.2` engines requirement still
# resolves), and re-verify the frontend build still succeeds — Dependabot
# (`.github/dependabot.yml`) also opens a PR automatically when a newer
# digest is available.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Security-review finding: the Cloudflare Turnstile PUBLIC site key
# (SignupScreen.jsx) is a build-time value — Vite statically inlines
# `import.meta.env.VITE_*` into the compiled bundle, it is never read at
# container-start/request time the way a backend env var is. Threaded
# through from docker-compose.prod.yml's `frontend.build.args` (itself from
# `.env.production`'s `VITE_TURNSTILE_SITE_KEY`). Confirmed live: a real
# `docker build` with this ARG set produces a `dist/assets/*.js` that
# genuinely contains the real site key value (grepped directly) — this is
# exactly the "the wiring looks right but the value never actually reaches
# the build" mistake worth checking for, not assuming.
ARG VITE_TURNSTILE_SITE_KEY
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
# Real production bug, user-reported: frontend/src/app/auth/screens/tenant-url.js
# builds a brand-new tenant's post-signup login URL from window.location
# alone, which cannot distinguish "the bare APP_DOMAIN" from "an existing
# tenant subdomain of it" once APP_DOMAIN is itself multi-level (e.g.
# lodgekeep.planmsys.com) — that file's own header has the full story.
# Threaded through the same way as VITE_TURNSTILE_SITE_KEY, above, reusing
# docker-compose.prod.yml's own top-level APP_DOMAIN value.
ARG VITE_APP_DOMAIN
ENV VITE_APP_DOMAIN=$VITE_APP_DOMAIN
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
# Also pinned by digest, same reasoning — the tag alone already carries
# the real version-sensitivity note above; the digest additionally makes
# the pull itself reproducible.
FROM caddy:2.11-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
COPY --from=build /app/dist /srv
COPY docker/frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
