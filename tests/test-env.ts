// Connection settings for the throwaway test databases (docker-compose.test.yml).
// DATAGRIPPE_TEST_DB_NAME isolates concurrent runs: each run seeds and uses its own database.
const dbName = process.env.DATAGRIPPE_TEST_DB_NAME ?? 'datagrippe_test'
if (!/^[a-z][a-z0-9_]{0,62}$/.test(dbName)) throw new Error(`Invalid DATAGRIPPE_TEST_DB_NAME: ${dbName}`)
export const TEST_PG = {
  host: '127.0.0.1',
  port: 55432,
  user: 'datagrippe',
  password: 'datagrippe_test',
  adminDatabase: 'postgres',
  database: dbName,
} as const

export const TEST_MSSQL = {
  host: '127.0.0.1',
  port: 51433,
  user: 'sa',
  password: 'Datagrippe_Test_1',
  adminDatabase: 'master',
  database: dbName,
} as const

/** Dev-mode Vault (docker-compose.test.yml). It sees the databases as postgres:5432 / mssql:1433. */
export const TEST_VAULT = {
  address: 'http://127.0.0.1:58200',
  rootToken: 'datagrippe-vault-root',
  /** Host names of the databases from inside the compose network. */
  pgHost: 'postgres',
  pgPort: 5432,
  mssqlHost: 'mssql',
  mssqlPort: 1433,
} as const
