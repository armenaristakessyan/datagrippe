// Fresh test databases for the e2e run, the dev Vault configured for them (Vault specs), and a guard
// against testing a stale or missing build.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedMssql } from '../setup/mssql'
import { seedPostgres } from '../setup/postgres'
import { seedVault } from '../setup/vault'

export default async function globalSetup(): Promise<void> {
  // Same build as fixtures.ts (a private build dir must have node_modules next to it, see scripts/snap.mjs).
  const outDir = process.env.DATAGRIPPE_E2E_OUT_DIR ? resolve(process.env.DATAGRIPPE_E2E_OUT_DIR) : resolve(__dirname, '../../out')
  const main = resolve(outDir, 'main/index.js')
  if (!existsSync(main)) throw new Error(`No build at ${main}: run "npm run build" first (npm run test:e2e does it).`)
  await seedPostgres()
  await seedMssql()
  // After the databases (the Vault roles grant on the seeded schemas). Without the Vault container (or when
  // configuring it fails) the Vault specs skip themselves; the other specs never depend on it.
  let ready = false
  try {
    ready = await seedVault()
  } catch (error) {
    console.error('[vault] Configuring the test Vault failed; the Vault specs are skipped.', error)
  }
  process.env.DATAGRIPPE_TEST_VAULT_READY = ready ? '1' : ''
}
