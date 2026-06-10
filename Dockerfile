# --- Build stage ---------------------------------------------------------- #
# Includes the native toolchain because pnpm 9+ may compile better-sqlite3
# or sqlite-vec for the active Node ABI when prebuilts don't match.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Install deps first so layer cache survives source-only edits. (.npmrc carries
# the `public-hoist-pattern[]=sqlite-vec-*` rule; the sqlite-vec native binary
# is also explicitly injected into the Nitro bundle after `pnpm build` below —
# see that step for why the hoist alone isn't enough.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .

# Nuxt build → .output/ (bundled Nitro server + client assets).
RUN pnpm build

# sqlite-vec resolves its native binary at runtime via
# `import.meta.resolve('sqlite-vec-<os>-<arch>/vec0.<ext>')`. Nitro's NFT trace
# can't follow that dynamic resolve, so the wrapper copied into
# .output/server/node_modules/sqlite-vec/ ships WITHOUT the binary next to it —
# at runtime the resolve throws ERR_MODULE_NOT_FOUND and vector search silently
# falls back to JS cosine. Inject the linux-x64 platform package next to the
# bundled wrapper so the very first resolve lookup hits it. `set -eux` + the
# `test -f` asserts make the build fail loudly if the package is missing (e.g.
# built on a non-amd64 host) instead of degrading silently in production.
RUN set -eux; \
    BIN="$(node -e "const fs=require('fs'),p=require('path');const b='node_modules/.pnpm';const d=fs.readdirSync(b).find(x=>x.startsWith('sqlite-vec-linux-x64@'));if(!d){console.error('sqlite-vec-linux-x64 not installed');process.exit(1)}process.stdout.write(p.join(b,d,'node_modules','sqlite-vec-linux-x64'))")"; \
    test -f "$BIN/vec0.so"; \
    mkdir -p .output/server/node_modules/sqlite-vec/node_modules; \
    cp -RL "$BIN" .output/server/node_modules/sqlite-vec/node_modules/sqlite-vec-linux-x64; \
    test -f .output/server/node_modules/sqlite-vec/node_modules/sqlite-vec-linux-x64/vec0.so

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
