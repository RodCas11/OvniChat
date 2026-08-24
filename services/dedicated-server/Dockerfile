# syntax=docker/dockerfile:1
#
# Chantivo Dedicated Server container image.
#
# Multi-stage: a full-monorepo build stage produces a pruned, production-only runtime directory via
# `pnpm deploy`, which the runtime stage then runs as a non-root user. No secret is ever baked into
# either stage — Coturn's TURN shared secret and every other DISCO_VOADOR_*/REALTIME_* value are
# supplied at `docker run`/Compose time via environment variables, never ARG/ENV here and never a
# copied .env file (see docs/SECURITY.md's "Secrets and configuration" section).
#
# Base image pinned to the exact Node 24.x patch this repository currently targets
# (package.json's `engines.node: ">=24 <25"`), matching this repository's own pinning discipline for
# infrastructure/coturn/turnserver.conf.example's `coturn/coturn:4.17.2-r0` — never `latest` or a
# floating major/minor tag. Re-pin deliberately on a future Node upgrade, not silently.

FROM node:24.18.1-slim AS build

# `packageManager` in the root package.json pins pnpm@11.22.0 exactly; corepack (bundled with
# Node 24) is the supported way to obtain that exact version reproducibly rather than a floating
# `npm install -g pnpm`.
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /repo

# The full monorepo context is required: @disco-voador/dedicated-server's `workspace:*` dependencies
# (@disco-voador/config, @disco-voador/protocol, @disco-voador/realtime, @disco-voador/shared, plus
# @disco-voador/identity as a transitive runtime dependency of @disco-voador/realtime) resolve only
# against the real workspace tree, not services/dedicated-server in isolation. See
# `.dockerignore` (repo root) for what is excluded from this context.
COPY . .

RUN pnpm install --frozen-lockfile

# Builds @disco-voador/dedicated-server and every workspace package it depends on. The trailing
# `...` is pnpm's own documented workspace filter syntax for "this package plus its dependency
# graph" (see https://pnpm.io/filtering) — it deliberately does NOT include apps/desktop or
# packages/windows-media, since the dedicated server has no dependency edge to either.
RUN pnpm --filter @disco-voador/dedicated-server... build

# Prunes to exactly @disco-voador/dedicated-server's real production dependency closure: no
# devDependencies (tsx, @disco-voador/identity's *dev* use, ws's @types), no apps/desktop, no
# Electron, no packages/windows-media. `--config.inject-workspace-packages=true` is required here —
# starting with pnpm v10, plain `pnpm deploy` on a workspace whose local packages are linked by
# reference (this repo's default) refuses to run and asks for either this flag or `--legacy` (which
# was verified, while preparing this Dockerfile, to silently re-resolve the dependency graph from
# the registry instead of the repo's own frozen `pnpm-lock.yaml`, and then fails outright on this
# repo's `extract-zip` patch entry, which belongs to a different workspace project's subgraph) — so
# `--legacy` is deliberately not used. The flag was verified locally (see the accompanying task
# report) to produce a real, reproducible, store-backed deploy with no network fetch, given the
# `pnpm install --frozen-lockfile` above already populated the store.
RUN pnpm --filter @disco-voador/dedicated-server deploy --prod --config.inject-workspace-packages=true /deploy

# ---

FROM node:24.18.1-slim AS runtime

# Fixed, deterministic non-root uid/gid, never the image's default root user. 10001 avoids
# colliding with any dynamically-assigned system uid Debian's own base image reserves under 1000.
RUN groupadd --gid 10001 chantivo \
  && useradd --uid 10001 --gid chantivo --no-create-home --shell /usr/sbin/nologin chantivo

WORKDIR /app

COPY --from=build /deploy .

ENV NODE_ENV=production
# Pins the container's data directory to an explicit absolute path. This is a container-image-only
# decision — `services/dedicated-server/src/config.ts`'s own `DEFAULT_DATA_DIR` stays a relative
# path by design for bare-metal/dev use and is NOT changed by this file.
ENV DISCO_VOADOR_SERVER_DATA_DIR=/data

RUN mkdir -p /data && chown -R chantivo:chantivo /data /app

VOLUME ["/data"]

USER chantivo

# Matches REALTIME_PORT's default (services/realtime/src/config.ts) — the same port serves the
# WebSocket server and the GET /healthz / GET /readyz HTTP endpoints (services/realtime/src/server.ts).
EXPOSE 8090

# This is a `-slim` image: no curl/wget guaranteed present, and none is installed here just for a
# healthcheck. Node 24 ships a global `fetch`, so a real HTTP GET against the loopback health
# endpoint needs no extra process spawn or added package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/cli.js"]
