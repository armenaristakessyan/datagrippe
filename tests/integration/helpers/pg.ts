// Shared helpers for the PostgreSQL driver regression tests (private database via DATAGRIPPE_TEST_DB_NAME).
import pg from 'pg'
import { postgresDriver } from '../../../src/main/db/postgres'
import type { DriverSession } from '../../../src/main/db/types'
import { testPgConnection } from '../../setup/postgres'
import { TEST_PG } from '../../test-env'

export function adminClient(): pg.Client {
  const client = new pg.Client({
    host: TEST_PG.host,
    port: TEST_PG.port,
    user: TEST_PG.user,
    password: TEST_PG.password,
    database: TEST_PG.database,
  })
  client.on('error', () => undefined)
  return client
}

export const openSession = (): Promise<DriverSession> => postgresDriver.openSession(testPgConnection(), TEST_PG.database)

/** Run `fn` with a fresh console session that is always closed (a failed assertion must not leave locks behind). */
export async function withSession<T>(fn: (session: DriverSession) => Promise<T>): Promise<T> {
  const session = await openSession()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}
