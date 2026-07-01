#!/usr/bin/env bash
# Bootstraps a physical streaming standby from the primary, then hands off to the
# stock postgres entrypoint. Idempotent: only runs pg_basebackup on an empty data dir.
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] waiting for primary to accept connections..."
  until pg_isready -h primary -p 5432 -U notability >/dev/null 2>&1; do sleep 1; done

  echo "[replica] cloning primary via pg_basebackup..."
  rm -rf "${PGDATA:?}/"* || true
  # -R writes standby.signal + primary_conninfo so the clone comes up as a streaming standby.
  gosu postgres bash -c "PGPASSWORD=notability pg_basebackup -h primary -p 5432 -U notability -D '$PGDATA' -Fp -Xs -P -R"
  echo "[replica] basebackup complete; starting as standby."
fi

exec docker-entrypoint.sh "$@"
