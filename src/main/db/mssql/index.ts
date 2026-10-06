// SQL Server driver (tedious for sessions, mssql pool for metadata).
import type { DbDriver, ResolvedConnection } from '../types'
import type { ServerInfo } from '@shared/types'
import { resolveOptions } from './config'
import { closeConnection, openConnection } from './connection'
import { MssqlMetadata } from './metadata'
import {
  attachMessageRouting,
  MssqlSession,
  queryOnce,
  SERVER_INFO_SQL,
  serverInfoFromRow,
  type MessageRouter,
} from './session'

async function test(connection: ResolvedConnection): Promise<ServerInfo> {
  const options = await resolveOptions(connection)
  const tds = await openConnection(options)
  tds.on('error', () => undefined)
  const router: MessageRouter = {}
  attachMessageRouting(tds, router)
  try {
    const [rows] = await queryOnce(tds, router, SERVER_INFO_SQL)
    return serverInfoFromRow(rows?.[0])
  } finally {
    await closeConnection(tds)
  }
}

export const mssqlDriver: DbDriver = {
  dialect: 'mssql',
  test,
  openMetadata: (connection) => MssqlMetadata.open(connection),
  openSession: (connection, database) => MssqlSession.open(connection, database),
}
