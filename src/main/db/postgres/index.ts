// PostgreSQL driver (pg + pg-cursor).
import type { DbDriver } from '../types'
import { connectClient, queryServerInfo } from './connect'
import { toDriverError } from './errors'
import { PostgresMetadata } from './metadata'
import { PostgresSession } from './session'

export const postgresDriver: DbDriver = {
  dialect: 'postgres',

  async test(connection) {
    const { client } = await connectClient(connection, connection.config.database)
    try {
      return await queryServerInfo(client)
    } catch (error) {
      throw toDriverError(error)
    } finally {
      await client.end().catch(() => undefined)
    }
  },

  openMetadata: (connection) => PostgresMetadata.open(connection),

  openSession: (connection, database) => PostgresSession.open(connection, database),
}
