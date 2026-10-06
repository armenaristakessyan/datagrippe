// Direct access to the test databases, to check what the app actually wrote.
import sql from 'mssql'
import pg from 'pg'
import { TEST_MSSQL, TEST_PG } from '../test-env'

export async function queryPg<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
  await client.connect()
  try {
    return (await client.query<T>(text, params)).rows
  } finally {
    await client.end()
  }
}

export async function queryMssql<T extends Record<string, unknown>>(text: string): Promise<T[]> {
  const pool = new sql.ConnectionPool({
    server: TEST_MSSQL.host,
    port: TEST_MSSQL.port,
    user: TEST_MSSQL.user,
    password: TEST_MSSQL.password,
    database: TEST_MSSQL.database,
    options: { encrypt: true, trustServerCertificate: true },
  })
  pool.on('error', () => undefined)
  await pool.connect()
  try {
    return (await pool.request().query<T>(text)).recordset
  } finally {
    await pool.close()
  }
}
