import {
  bytesBehind,
  config,
  dumpPgdogLogs,
  ensurePgdogDebugLogging,
  ensureStackUp,
  recentRoutes,
  routeProbe,
  saveRouterDecisions,
  severReplicaStreaming,
  showReplication,
  sleep,
  startPrimaryWriter,
  waitReplicaStreaming
} from './helpers'

// Lag-ban test: sever the standby's streaming, keep writing to the primary so the LSN gap
// grows, and watch whether pgdog (ban_replica_lag / ban_replica_lag_bytes) bans the replica
// and stops routing opt-in reads to it.
//
// Observed in pgdog v0.1.46: SHOW REPLICATION shows the replica pg_lsn freezing while the
// primary advances, but replica_lag stays 0 and the replica is never banned.

const POLLS = 8
const POLL_INTERVAL_MS = 4000

async function main() {
  await ensureStackUp()
  await ensurePgdogDebugLogging()
  const startedAt = Date.now()
  console.log('==> waiting for replica to be streaming + caught up')
  await waitReplicaStreaming()
  await sleep(2000)

  console.log('\n=== BASELINE (replica healthy) ===')
  printReplication(await showReplication())
  console.log(`role=replica routed to: ${await routeProbe(config.pgdogReplica)}`)

  console.log('\n==> severing replica streaming + writing to primary')
  const restore = await severReplicaStreaming()
  const stopWriter = startPrimaryWriter()

  let banned = false
  try {
    await sleep(2000)
    for (let i = 1; i <= POLLS; i++) {
      const rep = await showReplication()
      const replicaRow = rep.find((r) => r.role === 'replica')
      const route = await routeProbe(config.pgdogReplica)
      const behind = await bytesBehind()
      console.log(
        `t=${i * (POLL_INTERVAL_MS / 1000)}s  replica_lag=${replicaRow?.replica_lag}  ` +
          `replica pg_lsn=${replicaRow?.pg_lsn}  actual_bytes_behind=${behind}  role=replica -> ${route}`
      )
      for (const r of recentRoutes(POLL_INTERVAL_MS / 1000 + 1, 2)) console.log(`      pgdog: ${r}`)
      if ((replicaRow && Number(replicaRow.replica_lag) > 0) || route !== 'replica') banned = true
      await sleep(POLL_INTERVAL_MS)
    }
  } finally {
    await stopWriter()
    console.log('\n==> restoring replica streaming')
    await restore()
    await waitReplicaStreaming().catch(() => {})
  }

  const windowSecs = (Date.now() - startedAt) / 1000 + 5
  const full = dumpPgdogLogs('lag-pgdog.log', windowSecs)
  const decisions = saveRouterDecisions('lag-router-decisions.log', windowSecs)
  console.log(`\n==> full pgdog logs (${full.lines} lines) saved to ${full.path}`)
  console.log(`==> ${decisions.count} 'query router decision' blocks saved to ${decisions.path}`)

  console.log('\n================ LAG-BAN VERDICT ================')
  if (banned) {
    console.log('LAG BAN FIRED — pgdog detected the lag and stopped serving the replica.')
  } else {
    console.log('LAG BAN DID NOT FIRE — replica stayed in rotation despite a growing LSN gap.')
    console.log('(replica_lag stayed 0 even though pg_lsn diverged — pgdog v0.1.46 lag bug.)')
    console.log('(router decisions above show role=replica still chosen — lag never affected routing.)')
  }
  console.log('=================================================')
  process.exit(banned ? 0 : 1)
}

function printReplication(rows: Awaited<ReturnType<typeof showReplication>>) {
  for (const r of rows) {
    console.log(
      `  ${r.role.padEnd(7)} pg_lsn=${r.pg_lsn}  replica_lag=${r.replica_lag}  in_recovery=${r.pg_is_in_recovery}`
    )
  }
}

main().catch((err) => {
  console.error('[lag-ban-test] FAILED', err)
  process.exit(2)
})
