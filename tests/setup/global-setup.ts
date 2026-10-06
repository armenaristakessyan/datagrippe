// Vitest global setup for the integration project: (re)creates the test databases.
// Each driver work package implements its own seed module.
import { seedPostgres } from './postgres'
import { seedMssql } from './mssql'
import { seedVault } from './vault'

export default async function setup(): Promise<void> {
  const only = process.env.DATAGRIPPE_TEST_DB // 'postgres' | 'mssql' | undefined (both)
  if (!only || only === 'postgres') await seedPostgres()
  if (!only || only === 'mssql') await seedMssql()
  // After the databases: Vault roles grant on the seeded schemas. Skipped (with a warning) without the Vault container.
  try {
    await seedVault({ postgres: !only || only === 'postgres', mssql: !only || only === 'mssql' })
  } catch (error) {
    // Never block the other suites: the Vault tests then fail with Vault's own error.
    console.error('[vault] Configuring the test Vault failed; the Vault integration tests will fail.', error)
  }
}
