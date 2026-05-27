# --- Build stage ---------------------------------------------------------- #
# Includes the native toolchain because pnpm 9+ may compile better-sqlite3
# or sqlite-vec for the active Node ABI when prebuilts don't match.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Install deps first so layer cache survives source-only edits.
# .npmrc carries the `public-hoist-pattern[]=sqlite-vec-*` rule that lifts the
# platform binary (sqlite-vec-linux-x64) to /app/node_modules/, where Nitro's
# bundled sqlite-vec wrapper can reach it via Node's parent-directory walk.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .

# Nuxt build → .output/ (bundled Nitro server + client assets).
RUN pnpm build

# --- Runtime stage -------------------------------------------------------- #
# Slim image with just curl (for the HTTP healthcheck) and the bits needed
# to run the bundled .output/server/index.mjs + the at-boot migration runner.
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV DATABASE_URL=/app/data/noteforge.db
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
ENV MIGRATIONS_DIR=/app/server/database/migrations

# Nitro's bundled server output.
COPY --from=build /app/.output ./.output

# Migration runner: a tiny plain-ESM script + the SQL files it applies.
# `node_modules` carries the native better-sqlite3 binding and drizzle-orm
# needed by docker/migrate.mjs — Nitro internalises its OWN copy under
# .output/server, this top-level one is only used by the at-boot script.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/database/migrations ./server/database/migrations
COPY --from=build /app/docker ./docker

RUN chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
