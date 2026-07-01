#!/usr/bin/env bash
# Standalone demo: prove per-query opt-in to a read replica through pgdog (prefer_primary)
# with TypeORM. No common-backend dependency, no entities, no migrations — the DataSource
# plumbing is vendored in ./src/db.ts and the demo/tests create their own tables with raw SQL.
set -euo pipefail

cd "$(dirname "$0")"
DC="docker compose"
PGURL="postgresql://notability:notability@127.0.0.1:26432/notability"

if [ "${1:-}" = "down" ]; then
  $DC down -v --remove-orphans
  exit 0
fi

wait_healthy() {
  local svc=$1 cid
  echo "==> waiting for '$svc' to be healthy"
  while true; do
    cid="$($DC ps -q "$svc" || true)"
    if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ]; then
      break
    fi
    sleep 1
  done
}

echo "==> tearing down any previous run"
$DC down -v --remove-orphans || true

echo "==> starting primary"
$DC up -d primary
wait_healthy primary

echo "==> starting replica (pg_basebackup clone of the empty primary)"
$DC up -d replica
wait_healthy replica

echo "==> starting pgdog"
$DC up -d pgdog

echo "==> waiting for pgdog to accept connections (127.0.0.1:26432)"
until psql "$PGURL" -tAc 'select 1' >/dev/null 2>&1; do sleep 1; done

echo "==> running demo through pgdog (creates its table with 'create table if not exists')"
set +e
DB_HOST=127.0.0.1 DB_PORT=26432 DB_REPLICA_HOST=127.0.0.1 DB_PASSWORD=notability DB_NAME=notability \
    bun run demo.ts
DEMO_RC=$?
set -e

echo ""
echo "==> out-of-band proof: which Postgres logged each probe?"
echo "--- PRIMARY log (expect DEMO_PRIMARY_PROBE only) ---"
$DC logs primary 2>&1 | grep -E "DEMO_(PRIMARY|REPLICA)_PROBE" | tail -10 || echo "(none)"
echo "--- REPLICA log (expect DEMO_REPLICA_PROBE only) ---"
$DC logs replica 2>&1 | grep -E "DEMO_(PRIMARY|REPLICA)_PROBE" | tail -10 || echo "(none)"

echo ""
echo "==> demo exit code: $DEMO_RC  (containers left up; './run.sh down' to clean up)"
echo "==> ban tests: bun run tests/lag-ban-test.ts (and healthcheck-ban-test.ts)"
exit $DEMO_RC
