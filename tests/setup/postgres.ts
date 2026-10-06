// Recreate the PostgreSQL test database from tests/fixtures/postgres-seed.sql.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import type { ConnectionConfig } from '../../src/shared/types'
import type { ResolvedConnection } from '../../src/main/db/types'
import { TEST_PG } from '../test-env'

// __dirname: these seeders also run under Playwright (CommonJS), where import.meta is unavailable.
const SEED_PATH = join(__dirname, '../fixtures/postgres-seed.sql')
const CONNECT_ATTEMPTS = 60

function client(database: string): pg.Client {
  return new pg.Client({
    host: TEST_PG.host,
    port: TEST_PG.port,
    user: TEST_PG.user,
    password: TEST_PG.password,
    database,
    connectionTimeoutMillis: 5_000,
  })
}

/** Connect, retrying while the container is still starting up. */
async function connectWithRetry(database: string): Promise<pg.Client> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    const c = client(database)
    c.on('error', () => undefined)
    try {
      await c.connect()
      await c.query('SELECT 1')
      return c
    } catch (error) {
      lastError = error
      await c.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`PostgreSQL test server is not reachable at ${TEST_PG.host}:${TEST_PG.port}: ${String(lastError)}`)
}

export async function seedPostgres(): Promise<void> {
  const admin = await connectWithRetry(TEST_PG.adminDatabase)
  try {
    // Several test runs may start at once: serialize drop / create / seed across them.
    await admin.query(`SELECT pg_advisory_lock(hashtext('${TEST_PG.database}_seed'))`)
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_PG.database} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${TEST_PG.database}`)
    const db = await connectWithRetry(TEST_PG.database)
    try {
      // No parameters → simple query protocol, which accepts the whole multi-statement script.
      await db.query(readFileSync(SEED_PATH, 'utf8'))
    } finally {
      await db.end()
    }
  } finally {
    await admin.end()
  }
}

/** A ResolvedConnection for the test server, as the session manager would build it (password null = none). */
export function testPgConnection(overrides: Partial<ConnectionConfig> = {}, password: string | null = TEST_PG.password): ResolvedConnection {
  const now = new Date(0).toISOString()
  const config: ConnectionConfig = {
    id: 'test-pg',
    name: 'Test PostgreSQL',
    dialect: 'postgres',
    host: TEST_PG.host,
    port: TEST_PG.port,
    database: TEST_PG.database,
    user: TEST_PG.user,
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  return { config, secrets: password === null ? {} : { password }, host: config.host, port: config.port }
}
