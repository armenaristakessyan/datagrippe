// Configure the dev-mode Vault of docker-compose.test.yml for the Vault integration tests (idempotent).
// Every object is namespaced by DATAGRIPPE_TEST_DB_NAME so concurrent runs do not collide:
//   <db>-database   database secrets engine: connections <db>-pg / <db>-mssql, roles <db>-pg-ro, <db>-pg-short, <db>-mssql-ro
//   <db>-kv         KV v2 with the static test credentials (pg, mssql)
//   <db>-userpass   userpass auth: <db>-alice (reader policy) and <db>-bob (policy denying those paths)
//   <db>/gcp/prod/data/pg-analytics-prod-7x2k9q1/<db>   deep database mounts laid out like a real organisation's
//   <db>/gcp/prod/data/acme/server                       ("<cloud>/<env>/<team>/<instance>/<database>"), role read_only
// Credentials here are test-only values (tests/test-env.ts).
import pg from 'pg'
import { TEST_MSSQL, TEST_PG, TEST_VAULT } from '../test-env'

export function vaultNames(db: string = TEST_PG.database) {
  return {
    db,
    dbMount: `${db}-database`,
    kvMount: `${db}-kv`,
    userpassMount: `${db}-userpass`,
    pgConnection: `${db}-pg`,
    mssqlConnection: `${db}-mssql`,
    pgRole: `${db}-pg-ro`,
    pgShortRole: `${db}-pg-short`,
    mssqlRole: `${db}-mssql-ro`,
    readerPolicy: `${db}-reader`,
    deniedPolicy: `${db}-denied`,
    /** Deep mounts (secret path discovery): PostgreSQL test database / SQL Server, role read_only. */
    deepPgMount: `${db}/gcp/prod/data/pg-analytics-prod-7x2k9q1/${db}`,
    deepMssqlMount: `${db}/gcp/prod/data/acme/server`,
    deepRole: 'read_only',
    readerUser: `${db}-alice`,
    readerPassword: 'alice-test-password',
    deniedUser: `${db}-bob`,
    deniedPassword: 'bob-test-password',
  }
}

export type VaultNames = ReturnType<typeof vaultNames>

/** Root-token call to the dev Vault. Throws with Vault's error text on failure. */
export async function vaultApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TEST_VAULT.address}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': TEST_VAULT.rootToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Vault ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : null) as T
}

/** The dev Vault answers (unsealed). */
export async function vaultAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${TEST_VAULT.address}/v1/sys/health`, { signal: AbortSignal.timeout(2_000) })
    return res.status === 200
  } catch {
    return false
  }
}

/** Enable a secrets engine / auth method once (tolerates a concurrent run enabling it first). */
async function ensureEnabled(kind: 'mounts' | 'auth', path: string, body: Record<string, unknown>): Promise<void> {
  const exists = async () => `${path}/` in (await vaultApi<{ data: Record<string, unknown> }>('GET', `sys/${kind}`)).data
  if (await exists()) return
  try {
    await vaultApi('POST', `sys/${kind}/${path}`, body)
  } catch (error) {
    if (!(await exists())) throw error
  }
}

const ensureMount = (path: string, type: string, options?: Record<string, string>) => ensureEnabled('mounts', path, { type, ...(options ? { options } : {}) })
const ensureAuth = (path: string, type: string) => ensureEnabled('auth', path, { type })

async function pgSchemas(): Promise<string[]> {
  const client = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
  await client.connect()
  try {
    const { rows } = await client.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
    )
    return rows.map((r) => r.nspname)
  } finally {
    await client.end()
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

async function configurePostgres(n: VaultNames): Promise<void> {
  const schemas = await pgSchemas()
  await vaultApi('POST', `${n.dbMount}/config/${n.pgConnection}`, {
    plugin_name: 'postgresql-database-plugin',
    connection_url: `postgresql://{{username}}:{{password}}@${TEST_VAULT.pgHost}:${TEST_VAULT.pgPort}/${n.db}?sslmode=disable`,
    username: TEST_PG.user,
    password: TEST_PG.password,
    allowed_roles: [n.pgRole, n.pgShortRole],
    verify_connection: true,
  })
  const creation = [
    `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';`,
    `GRANT CONNECT ON DATABASE ${ident(n.db)} TO "{{name}}";`,
    ...schemas.map((s) => `GRANT USAGE ON SCHEMA ${ident(s)} TO "{{name}}";`),
    ...schemas.map((s) => `GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(s)} TO "{{name}}";`),
  ]
  const revocation = [
    ...schemas.map((s) => `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${ident(s)} FROM "{{name}}";`),
    ...schemas.map((s) => `REVOKE USAGE ON SCHEMA ${ident(s)} FROM "{{name}}";`),
    `REVOKE CONNECT ON DATABASE ${ident(n.db)} FROM "{{name}}";`,
    `DROP ROLE IF EXISTS "{{name}}";`,
  ]
  const role = { db_name: n.pgConnection, creation_statements: creation, revocation_statements: revocation }
  await vaultApi('POST', `${n.dbMount}/roles/${n.pgRole}`, { ...role, default_ttl: '1h', max_ttl: '24h' })
  await vaultApi('POST', `${n.dbMount}/roles/${n.pgShortRole}`, { ...role, default_ttl: '8s', max_ttl: '20s' })
  await vaultApi('POST', `${n.kvMount}/data/pg`, { data: { username: TEST_PG.user, password: TEST_PG.password } })
}

async function configureMssql(n: VaultNames): Promise<void> {
  await vaultApi('POST', `${n.dbMount}/config/${n.mssqlConnection}`, {
    plugin_name: 'mssql-database-plugin',
    connection_url: `sqlserver://{{username}}:{{password}}@${TEST_VAULT.mssqlHost}:${TEST_VAULT.mssqlPort}`,
    username: TEST_MSSQL.user,
    password: TEST_MSSQL.password,
    allowed_roles: [n.mssqlRole],
    verify_connection: true,
  })
  await vaultApi('POST', `${n.dbMount}/roles/${n.mssqlRole}`, {
    db_name: n.mssqlConnection,
    creation_statements: [
      `CREATE LOGIN [{{name}}] WITH PASSWORD = '{{password}}';`,
      `USE [${n.db}];`,
      `CREATE USER [{{name}}] FOR LOGIN [{{name}}];`,
      `ALTER ROLE db_datareader ADD MEMBER [{{name}}];`,
    ],
    // Default revocation: drop the user in every database, kill its sessions, drop the login.
    default_ttl: '1h',
    max_ttl: '24h',
  })
  await vaultApi('POST', `${n.kvMount}/data/mssql`, { data: { username: TEST_MSSQL.user, password: TEST_MSSQL.password } })
}

/** Database secrets engines laid out per instance, like the user's organisation (secret path discovery). */
async function configureDeepMounts(n: VaultNames, engines: { postgres: boolean; mssql: boolean }): Promise<void> {
  if (engines.postgres) {
    await ensureMount(n.deepPgMount, 'database')
    const schemas = await pgSchemas()
    await vaultApi('POST', `${n.deepPgMount}/config/pg`, {
      plugin_name: 'postgresql-database-plugin',
      connection_url: `postgresql://{{username}}:{{password}}@${TEST_VAULT.pgHost}:${TEST_VAULT.pgPort}/${n.db}?sslmode=disable`,
      username: TEST_PG.user,
      password: TEST_PG.password,
      allowed_roles: [n.deepRole],
      verify_connection: true,
    })
    await vaultApi('POST', `${n.deepPgMount}/roles/${n.deepRole}`, {
      db_name: 'pg',
      creation_statements: [
        `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';`,
        `GRANT CONNECT ON DATABASE ${ident(n.db)} TO "{{name}}";`,
        ...schemas.map((s) => `GRANT USAGE ON SCHEMA ${ident(s)} TO "{{name}}";`),
        ...schemas.map((s) => `GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(s)} TO "{{name}}";`),
      ],
      revocation_statements: [
        ...schemas.map((s) => `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${ident(s)} FROM "{{name}}";`),
        ...schemas.map((s) => `REVOKE USAGE ON SCHEMA ${ident(s)} FROM "{{name}}";`),
        `REVOKE CONNECT ON DATABASE ${ident(n.db)} FROM "{{name}}";`,
        `DROP ROLE IF EXISTS "{{name}}";`,
      ],
      default_ttl: '1h',
      max_ttl: '24h',
    })
  }
  if (engines.mssql) {
    await ensureMount(n.deepMssqlMount, 'database')
    await vaultApi('POST', `${n.deepMssqlMount}/config/mssql`, {
      plugin_name: 'mssql-database-plugin',
      connection_url: `sqlserver://{{username}}:{{password}}@${TEST_VAULT.mssqlHost}:${TEST_VAULT.mssqlPort}`,
      username: TEST_MSSQL.user,
      password: TEST_MSSQL.password,
      allowed_roles: [n.deepRole],
      verify_connection: true,
    })
    await vaultApi('POST', `${n.deepMssqlMount}/roles/${n.deepRole}`, {
      db_name: 'mssql',
      creation_statements: [
        `CREATE LOGIN [{{name}}] WITH PASSWORD = '{{password}}';`,
        `USE [${n.db}];`,
        `CREATE USER [{{name}}] FOR LOGIN [{{name}}];`,
        `ALTER ROLE db_datareader ADD MEMBER [{{name}}];`,
      ],
      default_ttl: '1h',
      max_ttl: '24h',
    })
  }
}

async function configureAuth(n: VaultNames): Promise<void> {
  await vaultApi('PUT', `sys/policies/acl/${n.readerPolicy}`, {
    policy: [
      `path "${n.dbMount}/creds/*" { capabilities = ["read"] }`,
      `path "${n.db}/gcp/*" { capabilities = ["read"] }`,
      `path "${n.kvMount}/data/*" { capabilities = ["read"] }`,
      `path "sys/leases/renew" { capabilities = ["update"] }`,
      `path "sys/leases/revoke" { capabilities = ["update"] }`,
    ].join('\n'),
  })
  await vaultApi('PUT', `sys/policies/acl/${n.deniedPolicy}`, {
    policy: `path "${n.kvMount}/metadata/*" { capabilities = ["list"] }`,
  })
  await vaultApi('POST', `auth/${n.userpassMount}/users/${n.readerUser}`, { password: n.readerPassword, token_policies: [n.readerPolicy], token_ttl: '1h' })
  await vaultApi('POST', `auth/${n.userpassMount}/users/${n.deniedUser}`, { password: n.deniedPassword, token_policies: [n.deniedPolicy], token_ttl: '1h' })
}

/**
 * Configure the dev Vault for this run's databases. Resolves false (with a warning) when the Vault container
 * is not running: the Vault integration tests then skip themselves.
 */
export async function seedVault(engines: { postgres: boolean; mssql: boolean } = { postgres: true, mssql: true }): Promise<boolean> {
  if (!(await vaultAvailable())) {
    console.warn(`[vault] The test Vault (${TEST_VAULT.address}) is not running: Vault integration tests are skipped. Start it with "npm run db:up".`)
    return false
  }
  const n = vaultNames()
  await ensureMount(n.dbMount, 'database')
  await ensureMount(n.kvMount, 'kv', { version: '2' })
  await ensureAuth(n.userpassMount, 'userpass')
  await configureAuth(n)
  if (engines.postgres) await configurePostgres(n)
  if (engines.mssql) await configureMssql(n)
  await configureDeepMounts(n, engines)
  return true
}

/** A token with the reader policy (token login tests). */
export async function readerToken(ttl = '10m'): Promise<string> {
  const n = vaultNames()
  const res = await vaultApi<{ auth: { client_token: string } }>('POST', 'auth/token/create', { policies: [n.readerPolicy], ttl, no_parent: true })
  return res.auth.client_token
}
