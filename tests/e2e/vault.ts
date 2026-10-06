// Helpers of the Vault / DBeaver import specs: the dev Vault objects of this run (tests/setup/vault.ts),
// lease checks through the Vault API, and a sanitized DBeaver workspace whose connections point to the
// docker test databases (same shape as a real DBeaver PROD file with "auth-model": "vault").
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_MSSQL, TEST_PG, TEST_VAULT } from '../test-env'
import { vaultApi, vaultNames } from '../setup/vault'
import { expect, test, type Dg } from './fixtures'

export const VAULT = { ...vaultNames(), address: TEST_VAULT.address }

/** Skip the current describe block when the e2e global setup could not configure the dev Vault. */
export function requireVault(): void {
  test.skip(process.env.DATAGRIPPE_TEST_VAULT_READY !== '1', 'The test Vault is not running (npm run db:up).')
}

/** Lease ids currently issued for a role of a database secrets engine (default: this run's main one). */
export async function leaseIds(role: string, mount: string = VAULT.dbMount): Promise<string[]> {
  try {
    const res = await vaultApi<{ data: { keys: string[] } }>('GET', `sys/leases/lookup/${mount}/creds/${role}/?list=true`)
    return res.data.keys
  } catch (error) {
    if (/\(404\)/.test(String(error))) return []
    throw error
  }
}

/** Leases of `role` issued since `before` (a leaseIds() snapshot). */
export async function newLeases(role: string, before: readonly string[], mount: string = VAULT.dbMount): Promise<string[]> {
  return (await leaseIds(role, mount)).filter((id) => !before.includes(id))
}

// ---------------------------------------------------------------------------
// DBeaver workspace
// ---------------------------------------------------------------------------

export const DBEAVER = {
  analytics: 'PGSQL - Analytics - warehouse',
  payments: 'PGSQL - All Payments DBs - pg-payments.example.cloud',
  ledger: 'PGSQL - Ledger - @pg-ledger.example.cloud',
  mssql: 'SQL SERVER - billing-prod',
} as const

/** DBeaver's default workspace under `homeDir` for this platform (what the scanner looks at). */
export function dbeaverWorkspace(homeDir: string): string {
  if (process.platform === 'darwin') return join(homeDir, 'Library/DBeaverData/workspace6')
  if (process.platform === 'win32') return join(homeDir, 'AppData/Roaming/DBeaverData/workspace6')
  return join(homeDir, '.local/share/DBeaverData/workspace6')
}

/**
 * Write General/.dbeaver/data-sources-prod.json: 3 PostgreSQL + 1 SQL Server Vault connections in folder
 * PROD, pointing to the test databases. Returns the .dbeaver folder.
 */
export function writeDbeaverWorkspace(homeDir: string): string {
  const pg = (database: string) => ({
    host: TEST_PG.host,
    port: String(TEST_PG.port),
    database,
    url: `jdbc:postgresql://${TEST_PG.host}:${TEST_PG.port}/${database}`,
    configurationType: 'MANUAL',
    type: 'dev',
    closeIdleConnection: false,
    'auth-model': 'vault',
  })
  const file = {
    folders: { PROD: {} },
    connections: {
      'postgres-jdbc-prod-analytics': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: DBEAVER.analytics,
        folder: 'PROD',
        configuration: { ...pg(TEST_PG.database), 'provider-properties': { '@dbeaver-show-non-default-db@': 'false' } },
      },
      'postgres-jdbc-prod-payments': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: DBEAVER.payments,
        folder: 'PROD',
        configuration: { ...pg('postgres'), 'provider-properties': { '@dbeaver-show-non-default-db@': 'true' } },
      },
      'postgres-jdbc-prod-ledger': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: DBEAVER.ledger,
        folder: 'PROD',
        // Never connected (no such database): only listed and imported.
        configuration: pg('ledger'),
      },
      'sqlserver-prod-billing-legacy': {
        provider: 'sqlserver',
        driver: 'microsoft',
        name: DBEAVER.mssql,
        folder: 'PROD',
        configuration: {
          host: TEST_MSSQL.host,
          port: String(TEST_MSSQL.port),
          database: TEST_MSSQL.database,
          url: `jdbc:sqlserver://;serverName=${TEST_MSSQL.host};port=${TEST_MSSQL.port};databaseName=${TEST_MSSQL.database}`,
          configurationType: 'MANUAL',
          type: 'dev',
          closeIdleConnection: false,
          'provider-properties': { '@dbeaver-show-all-schemas@': 'true', sslTrustServerCertificate: 'true' },
          'auth-model': 'vault',
        },
      },
    },
  }
  const dir = join(dbeaverWorkspace(homeDir), 'General/.dbeaver')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data-sources-prod.json'), JSON.stringify(file, null, 2))
  return dir
}

// ---------------------------------------------------------------------------
// App flows
// ---------------------------------------------------------------------------

/** Pick an option of a kit <Select> (Radix) by the start of its label. */
export async function selectOption(dg: Dg, triggerId: string, label: string): Promise<void> {
  await dg.page.locator(`#${triggerId}`).click()
  await dg.page.getByRole('option', { name: new RegExp(`^${label}`) }).click()
}

/** Open a console on the selected connection, run `sql` and return the single value it shows. */
export async function runScalar(dg: Dg, sql: string): Promise<string> {
  await dg.menu('New console')
  await expect(dg.editor).toBeVisible()
  await dg.typeSql(sql)
  await dg.page.keyboard.press('ControlOrMeta+Enter')
  const cell = dg.grid.getByRole('gridcell').filter({ hasText: /^v-/ }).first()
  await expect(cell).toBeVisible()
  return (await cell.textContent())?.trim() ?? ''
}

/** Connection row action from the explorer context menu. */
export async function contextAction(dg: Dg, connection: string, item: string): Promise<void> {
  await dg.treeItem(connection).click({ button: 'right' })
  await dg.page.getByRole('menuitem', { name: item }).click()
}

/** Answer the "Vault password" prompt. */
export async function answerVaultPassword(dg: Dg, password: string): Promise<void> {
  const prompt = dg.page.getByRole('dialog', { name: 'Vault password' })
  await expect(prompt).toBeVisible()
  await prompt.getByLabel(/password/i).first().fill(password)
  await dg.page.keyboard.press('Enter')
  await expect(prompt).toBeHidden()
}
