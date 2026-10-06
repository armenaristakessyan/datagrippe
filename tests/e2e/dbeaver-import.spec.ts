// Import from DBeaver: a PROD workspace whose 4 connections use "auth-model": "vault" (3 PostgreSQL,
// 1 SQL Server) is imported with shared Vault settings, then the imported connections connect with
// dynamic database users issued by the dev Vault, and their leases are revoked on disconnect.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryMssql, queryPg } from './db'
import { expect, test } from './fixtures'
import { answerVaultPassword, contextAction, DBEAVER, leaseIds, newLeases, requireVault, runScalar, selectOption, VAULT, writeDbeaverWorkspace } from './vault'

test.describe('import from DBeaver', () => {
  test.beforeEach(() => requireVault())

  test('imports Vault connections and connects them with dynamic credentials (PostgreSQL and SQL Server)', async ({ dg }) => {
    const { page } = dg
    const dbeaverDir = writeDbeaverWorkspace(dg.homeDir)
    // Paths are suggested from the deep mounts of the dev Vault ("<cloud>/<env>/<team>/<instance>/<database>").
    const pgPath = `${VAULT.deepPgMount}/creds/${VAULT.deepRole}`
    const mssqlPath = `${VAULT.deepMssqlMount}/creds/${VAULT.deepRole}`
    const pgBefore = await leaseIds(VAULT.deepRole, VAULT.deepPgMount)
    const mssqlBefore = await leaseIds(VAULT.deepRole, VAULT.deepMssqlMount)

    // File ▸ Import from DBeaver… scans the default workspace.
    await dg.menu('Import from DBeaver…')
    const dialog = page.getByRole('dialog', { name: 'Import from DBeaver' })
    await expect(dialog).toBeVisible()
    const list = dialog.getByRole('list', { name: 'DBeaver connections' })
    for (const name of Object.values(DBEAVER)) await expect(list.getByText(name, { exact: true })).toBeVisible()
    await expect(list.locator('section[aria-label="PROD"]')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Import 4 connections/ })).toBeDisabled()
    await dg.shot('scanned')

    // One set of Vault settings for the four connections.
    await dialog.locator('#dbv-vault-address').fill(VAULT.address)
    await selectOption(dg, 'dbv-vault-method', 'Userpass')
    await dialog.locator('#dbv-vault-mount').fill(VAULT.userpassMount)
    await dialog.locator('#dbv-vault-username').fill(VAULT.readerUser)
    await expect(dialog.locator('#dbv-vault-path-role')).toHaveValue('read_only')

    // Suggest paths from Vault: signs in (the Vault password is asked once) and matches each row to a mount.
    await dialog.getByRole('button', { name: 'Suggest paths from Vault' }).click()
    await answerVaultPassword(dg, VAULT.readerPassword)
    await expect(dialog.getByText(/2 of 4 matched · pick the others in their row/)).toBeVisible()
    await expect(dialog.getByLabel(`Vault secret path for ${DBEAVER.analytics}`)).toHaveValue(pgPath)
    await expect(dialog.getByLabel(`Vault secret path for ${DBEAVER.mssql}`)).toHaveValue(mssqlPath)
    await expect(dialog.getByText(/Suggested from Vault · \d+% match/).first()).toBeVisible()
    await dg.shot('vault-suggested')

    // The rows without a match: one picks a mount in its row, the other types its path.
    const paymentsRow = dialog.getByRole('listitem', { name: DBEAVER.payments })
    await paymentsRow.getByRole('button', { name: 'Pick a database mount' }).click()
    await page.getByRole('option', { name: new RegExp(VAULT.deepPgMount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click()
    await expect(dialog.getByLabel(`Vault secret path for ${DBEAVER.payments}`)).toHaveValue(pgPath)
    await dialog.getByLabel(`Vault secret path for ${DBEAVER.ledger}`).fill(pgPath)
    await dg.shot('vault-settings')

    await dialog.getByRole('button', { name: /^Import 4 connections/ }).click()
    await expect(dialog).toBeHidden()
    const toast = dg.toast('Imported 4 connections')
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: 'Show in sidebar' }).click()
    for (const name of Object.values(DBEAVER)) await expect(dg.treeItem(name)).toBeVisible()
    await expect(dg.treeItem('PROD')).toBeVisible()
    // Vault connections carry the Vault badge before they connect.
    await expect(dg.treeItem(DBEAVER.analytics).locator('svg[data-vault-tone]')).toBeVisible()
    await dg.shot('imported')

    // PostgreSQL: the Vault sign-in of "Suggest" is reused (no second password), and Vault issues a database user.
    await dg.treeItem(DBEAVER.analytics).dblclick()
    await expect(dg.treeItem('public')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const pgUser = await runScalar(dg, 'SELECT current_user')
    expect(pgUser).toMatch(/^v-/)
    await expect(page.getByTestId('vault-chip')).toHaveText(/Vault.*(1 h|59 min)/)
    expect(await newLeases(VAULT.deepRole, pgBefore, VAULT.deepPgMount)).toHaveLength(1)
    await dg.shot('postgres-vault-user')

    // Refresh: new credentials for new consoles.
    await contextAction(dg, DBEAVER.analytics, 'Refresh Vault credentials')
    await expect(dg.toast('Vault credentials refreshed')).toBeVisible()
    await dg.treeItem(DBEAVER.analytics).click()
    const refreshedUser = await runScalar(dg, 'SELECT current_user')
    expect(refreshedUser).toMatch(/^v-/)
    expect(refreshedUser).not.toBe(pgUser)
    await dg.shot('postgres-refreshed')

    // SQL Server: the Vault token is cached (no second prompt).
    await dg.treeItem(DBEAVER.mssql).dblclick()
    await expect(dg.treeItem('dbo')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await dg.treeItem(DBEAVER.mssql).click()
    const mssqlUser = await runScalar(dg, 'SELECT SUSER_NAME()')
    expect(mssqlUser).toMatch(/^v-/)
    expect(await newLeases(VAULT.deepRole, mssqlBefore, VAULT.deepMssqlMount)).toHaveLength(1)
    await dg.shot('mssql-vault-user')

    // Disconnecting revokes every lease: Vault drops the temporary users.
    await contextAction(dg, DBEAVER.analytics, 'Disconnect')
    await contextAction(dg, DBEAVER.mssql, 'Disconnect')
    await expect(page.getByTestId('vault-chip')).toHaveCount(0)
    await expect.poll(() => newLeases(VAULT.deepRole, pgBefore, VAULT.deepPgMount)).toEqual([])
    await expect.poll(() => newLeases(VAULT.deepRole, mssqlBefore, VAULT.deepMssqlMount)).toEqual([])
    expect(await queryPg('SELECT 1 FROM pg_roles WHERE rolname = ANY($1)', [[pgUser, refreshedUser]])).toEqual([])
    expect(await queryMssql(`SELECT 1 AS x FROM sys.server_principals WHERE name = N'${mssqlUser.replace(/'/g, "''")}'`)).toEqual([])
    await dg.shot('disconnected')

    // Picking the .dbeaver folder (macOS: file or folder) lists them again, as duplicates now.
    await dg.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as unknown as typeof dialog.showOpenDialog
    }, dbeaverDir)
    await dg.menu('Import from DBeaver…')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /^Choose file/ }).first().click()
    await expect(dialog.getByText(`Duplicate of “${DBEAVER.analytics}”`)).toBeVisible()
    await expect(dialog.getByText(/data-sources-prod\.json/).first()).toBeVisible()
    await dg.shot('duplicates')
  })
})

test.describe('import from DBeaver: unreadable files', () => {
  test('says why nothing was found instead of an empty list', async ({ dg }) => {
    const { page } = dg
    const bad = join(dg.homeDir, 'data-sources.json')
    writeFileSync(bad, '{ not json')
    await dg.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog
    }, bad)
    await dg.menu('Import from DBeaver…')
    const dialog = page.getByRole('dialog', { name: 'Import from DBeaver' })
    await expect(dialog).toBeVisible()
    // No workspace in this HOME: the default location is named, not "the DBeaver workspace".
    await expect(dialog).toContainText('No DBeaver workspace found')
    await dialog.getByRole('button', { name: /^Choose file/ }).first().click()
    await expect(dialog).toContainText('Could not read DBeaver connections from')
    // The reason is shown right away, not folded in a collapsed warning.
    await expect(dialog).toContainText('invalid JSON')
    await dg.shot('unreadable-file')
  })
})
