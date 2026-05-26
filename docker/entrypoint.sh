#!/bin/sh
set -e

# Apply pending SQLite migrations before booting the Nitro server. The
# `data/` volume is mounted from the host so we may be running against an
# empty database (first boot) or an existing one — drizzle's migrator is
# idempotent and tracks applied migrations in the `__drizzle_migrations`
# table.
#
# `migrate.mjs` is a tiny vendored runner copied into the image at build
# time; it intentionally avoids tsx so the runtime stage stays slim.
echo "[noteforge] applying migrations from ${MIGRATIONS_DIR:-/app/server/database/migrations}"
node /app/docker/migrate.mjs

echo "[noteforge] starting Nitro server on ${NITRO_PORT:-3000}"
exec node /app/.output/server/index.mjs
