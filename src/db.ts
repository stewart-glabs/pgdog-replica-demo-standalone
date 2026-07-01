import {DataSource, EntityManager} from 'typeorm'
import {PostgresConnectionOptions} from 'typeorm/driver/postgres/PostgresConnectionOptions'

// Standalone copy of the notability-services-common-backend DataSource plumbing, trimmed for the
// demo: NO entities, NO migrations, NO remote-config. Tests create their own tables with raw
// `create table if not exists` and issue raw queries via the EntityManager.

export interface DatabaseConfig {
  DB_HOST: string
  DB_PORT?: number
  DB_USERNAME?: string
  DB_PASSWORD: string
  DB_NAME?: string
  DB_MAX_POOL_SIZE?: number
  // When set, a read-replica slave pool is configured. In the single-pgdog design its VALUE is
  // unused (the slave dials DB_HOST); only its presence enables replica-opt-in reads.
  DB_REPLICA_HOST?: string
}

// pgdog routes reads to a replica only when the backend connection carries the
// `pgdog.role=replica` startup parameter (everything else stays on the primary under
// `read_write_split = prefer_primary`). TypeORM's `extra` is shared by the master and slave
// pools, so the role can't live there without diverting writes. The one per-pool channel that
// survives into pg's startup packet is the connection URL's `options` query param, so the
// replica opt-in lives on the slave URL — pointed at the SAME pgdog as the master.
function replicaConnectionUrl(c: {
  host: string
  port: number
  username: string
  password: string
  database: string
}): string {
  const params = new URLSearchParams({options: '-c pgdog.role=replica'})
  const auth = `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}`
  return `postgres://${auth}@${c.host}:${c.port}/${encodeURIComponent(c.database)}?${params.toString()}`
}

export function buildTypeormConfig(config: DatabaseConfig): PostgresConnectionOptions {
  const connection = {
    host: config.DB_HOST,
    port: config.DB_PORT ?? 5432,
    username: config.DB_USERNAME ?? 'notability',
    password: config.DB_PASSWORD,
    database: config.DB_NAME ?? 'notability'
  }

  const base = {
    type: 'postgres' as const,
    synchronize: false,
    entities: [],
    poolSize: config.DB_MAX_POOL_SIZE
  }

  if (!config.DB_REPLICA_HOST) {
    return {...base, ...connection}
  }

  return {
    ...base,
    replication: {
      defaultMode: 'master',
      master: connection,
      slaves: [{url: replicaConnectionUrl({...connection})}]
    }
  }
}

let _dataSource: DataSource | undefined

export async function initializeDatabaseConnection(config: DatabaseConfig): Promise<DataSource> {
  const dataSource = new DataSource(buildTypeormConfig(config))
  await dataSource.initialize()
  _dataSource = dataSource
  return dataSource
}

export function getDataSource(): DataSource {
  if (!_dataSource || !_dataSource.isInitialized) {
    throw new Error('DataSource not initialized — call initializeDatabaseConnection first')
  }
  return _dataSource
}

function replicaAvailable(dataSource: DataSource): boolean {
  const {options} = dataSource
  if (options.type !== 'postgres') {
    return false
  }
  return (options.replication?.slaves?.length ?? 0) > 0
}

/**
 * Run a read against the configured read replica, falling back to the primary when no replica is
 * configured. Callers opt in per query — nothing routes to the replica unless it flows through here.
 * When a replica exists, a `slave` query runner is pinned for the callback (its pool carries
 * pgdog.role=replica) and always released afterward.
 */
export async function getReadEntityManager<T>(
  fn: (manager: EntityManager) => Promise<T>,
  dataSource: DataSource = getDataSource()
): Promise<T> {
  if (!replicaAvailable(dataSource)) {
    return fn(dataSource.manager)
  }
  const queryRunner = dataSource.createQueryRunner('slave')
  try {
    return await fn(queryRunner.manager)
  } finally {
    await queryRunner.release()
  }
}
