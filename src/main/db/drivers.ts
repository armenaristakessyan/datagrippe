// Dialect → driver registry.
import type { Dialect } from '@shared/types'
import { assertHostAllowed } from '../automation-guard'
import { DriverError } from './errors'
import { mssqlDriver } from './mssql'
import { postgresDriver } from './postgres'
import type { DbDriver, ResolvedConnection } from './types'

export type DriverRegistry = (dialect: Dialect) => DbDriver

/** Automated runs (tests, agents) may only reach loopback servers — see automation-guard.ts. */
function checkTarget(connection: ResolvedConnection): void {
  assertHostAllowed(connection.host, 'database host')
  assertHostAllowed(connection.config.host, 'database host')
  if (connection.config.ssh?.enabled) assertHostAllowed(connection.config.ssh.host, 'SSH host')
}

function guarded(driver: DbDriver): DbDriver {
  return {
    dialect: driver.dialect,
    test: async (connection) => {
      checkTarget(connection)
      return driver.test(connection)
    },
    openMetadata: async (connection) => {
      checkTarget(connection)
      return driver.openMetadata(connection)
    },
    openSession: async (connection, database) => {
      checkTarget(connection)
      return driver.openSession(connection, database)
    },
  }
}

const DRIVERS: Record<Dialect, DbDriver> = {
  postgres: guarded(postgresDriver),
  mssql: guarded(mssqlDriver),
}

export const getDriver: DriverRegistry = (dialect) => {
  const driver = DRIVERS[dialect]
  if (!driver) throw DriverError.of('invalid-input', `Unsupported database type: ${String(dialect)}`)
  return driver
}
