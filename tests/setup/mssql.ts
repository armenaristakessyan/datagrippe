// Recreate the SQL Server test database from tests/fixtures/mssql-seed.sql — mssql-driver work package.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sql from 'mssql'
import type { ConnectionConfig } from '@shared/types'
import type { ResolvedConnection } from '../../src/main/db/types'
import { TEST_MSSQL } from '../test-env'

const READY_TIMEOUT_MS = 120_000

function poolConfig(database: string): sql.config {
  return {
    server: TEST_MSSQL.host,
    port: TEST_MSSQL.port,
    user: TEST_MSSQL.user,
    password: TEST_MSSQL.password,
    database,
    connectionTimeout: 5_000,
    requestTimeout: 120_000,
    pool: { max: 1, min: 0 },
    options: { encrypt: false, trustServerCertificate: true, appName: 'datagrippe-test-setup' },
  }
}

/** Connect to master, retrying while the container is still starting. */
async function connectWhenReady(): Promise<sql.ConnectionPool> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    const pool = new sql.ConnectionPool(poolConfig(TEST_MSSQL.adminDatabase))
    pool.on('error', () => undefined)
    try {
      await pool.connect()
      await pool.request().query('SELECT 1')
      return pool
    } catch (error) {
      lastError = error
      await pool.close().catch(() => undefined)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
  throw new Error(`SQL Server at ${TEST_MSSQL.host}:${TEST_MSSQL.port} is not ready: ${String(lastError)}`)
}

/** Split on lines containing only GO (the fixture never uses GO inside strings or comments). */
function seedBatches(script: string): string[] {
  return script
    .split(/^\s*GO\s*$/im)
    .map((batch) => batch.trim())
    .filter((batch) => batch.replace(/--.*$/gm, '').trim() !== '')
}

export async function seedMssql(): Promise<void> {
  const name = TEST_MSSQL.database
  // pool max 1: the session-owned app lock below stays on this one connection until close().
  const master = await connectWhenReady()
  try {
    // Several test runs (integration, e2e) may start at once: serialize drop / create / seed.
    await master.request().batch(`EXEC sp_getapplock @Resource = N'${TEST_MSSQL.database}_seed', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 180000`)
    await master.request().batch(`
      IF DB_ID(N'${name}') IS NOT NULL
      BEGIN
        ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${name}];
      END`)
    await master.request().batch(`CREATE DATABASE [${name}]`)

    const script = await readFile(join(__dirname, '../fixtures/mssql-seed.sql'), 'utf8') // __dirname: also runs under Playwright (CommonJS)
    const pool = new sql.ConnectionPool(poolConfig(name))
    pool.on('error', () => undefined)
    await pool.connect()
    try {
      for (const batch of seedBatches(script)) {
        try {
          await pool.request().batch(batch)
        } catch (error) {
          throw new Error(`Seeding ${name} failed on batch:\n${batch}\n${String(error)}`)
        }
      }
    } finally {
      await pool.close()
    }
  } finally {
    await master.close()
  }
}

/** ResolvedConnection for the test server, as the session manager would build it. */
export function mssqlTestConnection(
  overrides: Partial<ConnectionConfig> = {},
  password: string = TEST_MSSQL.password,
): ResolvedConnection {
  const config: ConnectionConfig = {
    id: 'mssql-test',
    name: 'SQL Server test',
    dialect: 'mssql',
    host: TEST_MSSQL.host,
    port: TEST_MSSQL.port,
    database: TEST_MSSQL.database,
    user: TEST_MSSQL.user,
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'require' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
  return { config, secrets: { password }, host: config.host, port: config.port }
}
