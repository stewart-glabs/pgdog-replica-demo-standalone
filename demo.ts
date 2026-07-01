import 'reflect-metadata'

import {getDataSource, getReadEntityManager, initializeDatabaseConnection} from './src/db'

// Standalone proof that per-query opt-in to a read replica works through pgdog (prefer_primary):
// - the default manager routes to the primary,
// - getReadEntityManager routes to the replica (via the slave pool's pgdog.role=replica),
// - both see the same data.
// No entities, no migrations — the table is created with raw `create table if not exists`.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function clusterName(manager: {query: (sql: string) => Promise<Array<{cluster: string}>>}, probe: string) {
  const rows = await manager.query(`${probe} select current_setting('cluster_name') as cluster`)
  return rows[0]?.cluster
}

async function main() {
  await initializeDatabaseConnection({
    DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
    DB_PORT: Number(process.env.DB_PORT ?? 16432),
    DB_REPLICA_HOST: process.env.DB_REPLICA_HOST ?? '127.0.0.1', // same pgdog as primary
    DB_PASSWORD: process.env.DB_PASSWORD ?? 'notability',
    DB_NAME: process.env.DB_NAME ?? 'notability',
    DB_MAX_POOL_SIZE: 2
  })

  const primary = getDataSource().manager

  // Create + seed on the primary (DDL/writes route to the primary under prefer_primary).
  await primary.query('create table if not exists demo_kv (id serial primary key, val text not null)')
  await primary.query("delete from demo_kv")
  await primary.query("insert into demo_kv (val) values ('hello-from-primary')")

  // Default manager -> primary.
  const primaryCluster = await clusterName(primary, '/* DEMO_PRIMARY_PROBE */')
  const [primaryRow] = await primary.query('select id, val from demo_kv order by id limit 1')

  // Opt-in read -> replica. Wait for the physical standby to replay the DDL + insert first
  // (retry both the not-yet-replicated table (42P01) and the empty-result cases).
  const replica = await getReadEntityManager(async (manager) => {
    let row: {id: number; val: string} | undefined
    for (let i = 0; i < 40; i++) {
      try {
        const rows = await manager.query('select id, val from demo_kv order by id limit 1')
        if (rows.length > 0) {
          row = rows[0]
          break
        }
      } catch {
        // table not replicated to the standby yet
      }
      await sleep(250)
    }
    const cluster = await clusterName(manager, '/* DEMO_REPLICA_PROBE */')
    return {cluster, row}
  })

  const checks = [
    {name: 'default manager hit PRIMARY', pass: primaryCluster === 'primary', detail: `cluster=${primaryCluster}`},
    {name: 'getReadEntityManager hit REPLICA', pass: replica.cluster === 'replica', detail: `cluster=${replica.cluster}`},
    {
      name: 'both saw the same row',
      pass: !!primaryRow && !!replica.row && primaryRow.id === replica.row.id && primaryRow.val === replica.row.val,
      detail: `primary=${JSON.stringify(primaryRow)} replica=${JSON.stringify(replica.row)}`
    }
  ]

  console.log('\n========== standalone pgdog replica opt-in demo ==========')
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`)
  console.log('==========================================================\n')

  await getDataSource().destroy()
  process.exit(checks.every((c) => c.pass) ? 0 : 1)
}

main().catch((err) => {
  console.error('[demo] FAILED', err)
  process.exit(1)
})
