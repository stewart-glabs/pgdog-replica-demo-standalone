# pgdog read-replica opt-in demo — standalone

A demo which proves per-query opt-in to a read replica through pgdog (`read_write_split = prefer_primary`). It also contains tests which repreducing lag and healthcheck replica banning which are used to find bugs in pgdog.

- The DataSource plumbing (`initializeDatabaseConnection`, `getDataSource`, `getReadEntityManager`,
  `buildTypeormConfig`) is vendored in [`src/db.ts`](src/db.ts).
- **No entities, no migrations.** The demo and tests create their own tables with
  `create table if not exists` and issue raw `manager.query(...)` calls.

It still uses the `typeorm` and `pg` packages, resolved from `Backend/node_modules`, so run the
bun scripts from the `Backend/` directory (as `run.sh` does).

## Setup
You need `bun`, and docker compose installed.

## Topology

Physical streaming standby, all in Docker on `127.0.0.1`, with distinct ports so this can run alongside the main demo: **25432** (primary), **25434** (replica), **26432** (pgdog). Project name
`pgdog-replica-demo-standalone`.

## Run

```bash
./run.sh          # bring up primary + replica + pgdog, then run demo.ts
./run.sh down     # tear everything down
```

`demo.ts` creates `demo_kv`, seeds a row on the primary, then asserts: default manager → primary,
`getReadEntityManager` → replica, and both see the same row.

## Ban tests (run after ./run.sh)

```bash
bun run tests/lag-ban-test.ts
bun run tests/healthcheck-ban-test.ts
```

Each ensures pgdog is at `RUST_LOG=debug` (recreating it if needed) so `query router decision`
lines are logged, snapshots `SHOW REPLICATION` / routing while inducing the failure, self-restores,
and writes artifacts: `*-pgdog.log` (full window) and `*-router-decisions.log`.

