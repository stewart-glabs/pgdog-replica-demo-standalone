import {execSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {Client, ClientConfig} from 'pg'

// Shared helpers for the pgdog replica ban test scripts. Assumes ./run.sh has brought the
// stack up: primary (25432), replica (25434), pgdog (26432) with the [admin] db enabled.
export const PORTS = {primary: 25432, replica: 25434, pgdog: 26432} as const

const PASSWORD = 'notability'

// tests/ -> demo dir (where docker-compose.yml lives)
export const DEMO_DIR = new URL('..', import.meta.url).pathname

export type Row = Record<string, string>

export function compose(args: string): string {
  return execSync(`docker compose ${args}`, {cwd: DEMO_DIR, encoding: 'utf8'}).trim()
}

// `query router decision` (and the readable `using route [...]` companion) are DEBUG-level.
// Warn if pgdog isn't running at debug/trace, since the lines won't exist otherwise.
export function pgdogLogLevel(): string {
  try {
    const env = execSync(`docker inspect $(docker compose ps -q pgdog) --format '{{json .Config.Env}}'`, {
      cwd: DEMO_DIR,
      encoding: 'utf8'
    })
    return env.match(/RUST_LOG=([^",]+)/i)?.[1] ?? 'unset'
  } catch {
    return 'unknown'
  }
}

// Ensure pgdog runs at debug (or trace) so `query router decision` lines are emitted.
// Recreates the pgdog container with RUST_LOG=debug when it isn't already; no-op otherwise.
export async function ensurePgdogDebugLogging(): Promise<void> {
  const level = pgdogLogLevel().toLowerCase()
  if (/debug|trace/.test(level)) {
    console.log(`==> pgdog already at RUST_LOG=${level}`)
    return
  }
  console.log(`==> pgdog RUST_LOG=${level}; recreating pgdog with RUST_LOG=debug`)
  execSync('docker compose up -d --force-recreate pgdog', {
    cwd: DEMO_DIR,
    env: {...process.env, RUST_LOG: 'debug'},
    stdio: 'ignore'
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await query(config.pgdogDefault, 'select 1')
      console.log('==> pgdog back up at RUST_LOG=debug')
      return
    } catch {
      await sleep(1000)
    }
  }
  throw new Error('pgdog did not become reachable after recreating at debug level')
}

// One-line resolved routes (shard + role) pgdog paired recent client queries to.
export function recentRoutes(sinceSeconds = 4, lastN = 4): string[] {
  return grepPgdogLogs(`grep -iE "using route \\[" | tail -${lastN}`, sinceSeconds)
}

// Full `query router decision: Query(...)` struct blocks (with context) for deep debugging.
export function routerDecisionBlocks(sinceSeconds = 6): string[] {
  const blocks = grepPgdogLogs(`grep -A8 -iF "query router decision"`, sinceSeconds).join('\n')
  return blocks
    ? blocks
        .split(/^--$/m)
        .map((b) => b.trim())
        .filter(Boolean)
    : []
}

// Dump every pgdog log line produced during the test window into a file (for sharing / deep debug).
export function dumpPgdogLogs(filename: string, sinceSeconds: number): {path: string; lines: number} {
  const path = join(DEMO_DIR, filename)
  const raw = execSync(`docker compose logs --since ${Math.ceil(sinceSeconds)}s --no-log-prefix pgdog 2>&1`, {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  writeFileSync(path, raw)
  return {path, lines: raw.split('\n').filter(Boolean).length}
}

export function saveRouterDecisions(filename: string, sinceSeconds: number): {path: string; count: number} {
  const blocks = routerDecisionBlocks(sinceSeconds)
  const path = join(DEMO_DIR, filename)
  writeFileSync(path, blocks.join('\n\n') + '\n')
  return {path, count: blocks.length}
}

function grepPgdogLogs(grepPipeline: string, sinceSeconds: number): string[] {
  try {
    const raw = execSync(
      `docker compose logs --since ${sinceSeconds}s --no-log-prefix pgdog 2>&1 | ${grepPipeline} || true`,
      {cwd: DEMO_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}
    )
    return raw
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
  } catch {
    return []
  }
}

function base(overrides: ClientConfig = {}): ClientConfig {
  return {host: '127.0.0.1', user: 'notability', password: PASSWORD, database: 'notability', ...overrides}
}

export const config = {
  primary: base({port: PORTS.primary}),
  replica: base({port: PORTS.replica}),
  pgdogDefault: base({port: PORTS.pgdog}),
  // The opt-in slave connection: pgdog.role=replica rides on the startup `options` parameter.
  pgdogReplica: base({port: PORTS.pgdog, options: '-c pgdog.role=replica'}),
  admin: base({port: PORTS.pgdog, user: 'admin', password: 'admindebug', database: 'admin'})
} satisfies Record<string, ClientConfig>

export async function query(cfg: ClientConfig, sql: string): Promise<Row[]> {
  const client = new Client(cfg)
  await client.connect()
  try {
    return (await client.query(sql)).rows as Row[]
  } finally {
    await client.end()
  }
}

export async function scalar(cfg: ClientConfig, sql: string): Promise<string | undefined> {
  const rows = await query(cfg, sql)
  const first = rows[0]
  return first ? Object.values(first)[0] : undefined
}

// Routing probe with a hard client-side timeout (the backend may be frozen). Returns the
// served cluster_name, or a classified failure ('TIMEOUT/hang' / 'ERR: ...').
export async function routeProbe(cfg: ClientConfig, timeoutMs = 5000): Promise<string> {
  const client = new Client({...cfg, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs})
  try {
    await client.connect()
    const rows = await client.query("select current_setting('cluster_name') as c")
    return String(rows.rows[0].c)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/timeout/i.test(msg)) return 'TIMEOUT/hang'
    return 'ERR: ' + msg.split('\n')[0].slice(0, 48)
  } finally {
    try {
      await client.end()
    } catch {
      /* already failed */
    }
  }
}

export async function showReplication(): Promise<Row[]> {
  return query(config.admin, 'SHOW REPLICATION')
}

// Bytes the replica's replayed position trails the primary's current WAL position.
export async function bytesBehind(): Promise<string> {
  const replayLsn = await scalar(config.replica, 'select pg_last_wal_replay_lsn()')
  return (await scalar(config.primary, `select pg_wal_lsn_diff(pg_current_wal_lsn(), '${replayLsn}')`)) ?? '?'
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function ensureStackUp(): Promise<void> {
  try {
    await query(config.pgdogDefault, 'select 1')
  } catch {
    console.error('pgdog not reachable on 127.0.0.1:26432 — run ./run.sh first.')
    process.exit(1)
  }
}

export async function waitReplicaStreaming(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await scalar(config.replica, 'select status from pg_stat_wal_receiver').catch(() => undefined)
    if (status === 'streaming') return
    await sleep(1000)
  }
  throw new Error('replica did not return to streaming in time')
}

// Continuously commit on the primary to advance its WAL position. Returns a stop function.
export function startPrimaryWriter(intervalMs = 400): () => Promise<void> {
  let running = true
  const loop = (async () => {
    await query(
      config.primary,
      'create table if not exists _lagtest(id serial primary key, t timestamptz default now())'
    )
    while (running) {
      await query(config.primary, 'insert into _lagtest(t) values (now())').catch(() => {})
      await sleep(intervalMs)
    }
  })()
  return async () => {
    running = false
    await loop
  }
}

// Cut the standby's streaming link by pointing it at an unroutable primary; returns a restore fn.
export async function severReplicaStreaming(): Promise<() => Promise<void>> {
  const original = await scalar(config.replica, "select setting from pg_settings where name='primary_conninfo'")
  await query(config.replica, "alter system set primary_conninfo='host=10.255.255.1 port=5432 user=notability'")
  await query(config.replica, 'select pg_reload_conf()')
  return async () => {
    await query(config.replica, `alter system set primary_conninfo='${original}'`)
    await query(config.replica, 'select pg_reload_conf()')
  }
}
