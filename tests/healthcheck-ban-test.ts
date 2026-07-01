import {
  compose,
  config,
  dumpPgdogLogs,
  ensurePgdogDebugLogging,
  ensureStackUp,
  query,
  recentRoutes,
  routeProbe,
  saveRouterDecisions,
  sleep
} from './helpers'

// Healthcheck-ban test: freeze the replica with `docker compose pause` (reachable, but
// unresponsive) so pgdog's healthcheck fails and bans the pool. Watch what an opt-in
// (pgdog.role=replica) read does once banned, and confirm default reads stay on the primary.
//
// Observed in pgdog v0.1.46 under read_write_split=prefer_primary: the replica IS banned
// (~5-10s, "pool is not healthy"), but role=replica then errors with "all replicas down" —
// it does NOT fail over to the primary. Default (no-role) reads stay on the primary throughout.

const POLLS = 12
const POLL_INTERVAL_MS = 3000
const PROBE_TIMEOUT_MS = 6000

async function poolFlags(): Promise<string> {
  const rows = await query(config.admin, 'SHOW POOLS')
  const replica = rows.find((r) => r.role === 'replica')
  return replica ? `banned=${replica.banned} healthy=${replica.healthy}` : '(no replica pool)'
}

async function main() {
  await ensureStackUp()
  await ensurePgdogDebugLogging()
  const startedAt = Date.now()

  console.log('=== BASELINE (replica healthy) ===')
  console.log(`role=replica -> ${await routeProbe(config.pgdogReplica, PROBE_TIMEOUT_MS)}   pool: ${await poolFlags()}`)

  console.log('\n==> pausing replica (docker compose pause)')
  compose('pause replica')

  let bannedError = false
  let defaultStayedPrimary = true
  try {
    for (let i = 1; i <= POLLS; i++) {
      const replicaRoute = await routeProbe(config.pgdogReplica, PROBE_TIMEOUT_MS)
      const defaultRoute = await routeProbe(config.pgdogDefault, PROBE_TIMEOUT_MS)
      const flags = await poolFlags().catch(() => '(admin unavailable)')
      console.log(
        `t=${i * (POLL_INTERVAL_MS / 1000)}s  role=replica -> ${replicaRoute.padEnd(34)}  ` +
          `default -> ${defaultRoute.padEnd(10)}  pool: ${flags}`
      )
      for (const r of recentRoutes(POLL_INTERVAL_MS / 1000 + 1, 2)) console.log(`      pgdog: ${r}`)
      if (/all replicas down|ERR:/i.test(replicaRoute)) bannedError = true
      if (defaultRoute !== 'primary') defaultStayedPrimary = false
      await sleep(POLL_INTERVAL_MS)
    }
  } finally {
    console.log('\n==> unpausing replica')
    compose('unpause replica')
    await sleep(3000)
  }

  const recovered = (await routeProbe(config.pgdogReplica, PROBE_TIMEOUT_MS)) === 'replica'

  const windowSecs = (Date.now() - startedAt) / 1000 + 5
  const full = dumpPgdogLogs('healthcheck-pgdog.log', windowSecs)
  const decisions = saveRouterDecisions('healthcheck-router-decisions.log', windowSecs)
  console.log(`\n==> full pgdog logs (${full.lines} lines) saved to ${full.path}`)
  console.log(`==> ${decisions.count} 'query router decision' blocks saved to ${decisions.path}`)

  console.log('\n============ HEALTHCHECK-BAN VERDICT ============')
  console.log(`replica health-banned (role=replica errored): ${bannedError ? 'YES' : 'NO'}`)
  console.log(
    `opt-in read failed over to primary instead of erroring: NO (prefer_primary treats role=replica as strict)`
  )
  console.log(`default (no-role) reads stayed on primary: ${defaultStayedPrimary ? 'YES' : 'NO'}`)
  console.log(`replica recovered after unpause: ${recovered ? 'YES' : 'NO'}`)
  console.log('=================================================')
  process.exit(bannedError && defaultStayedPrimary && recovered ? 0 : 1)
}

main().catch((err) => {
  console.error('[healthcheck-ban-test] FAILED', err)
  process.exit(2)
})
