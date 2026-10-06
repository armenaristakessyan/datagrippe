import { ENGINES, expect, relaunch, test } from './fixtures'

test.describe('connections', () => {
  test('creates PostgreSQL and SQL Server connections from the dialog and browses them', async ({ dg }) => {
    const { page } = dg
    await expect(page.getByText('No connections yet')).toBeVisible()
    await dg.shot('welcome')

    await dg.createConnection('postgres', { test: true })
    await dg.expand('Tables')
    await expect(dg.treeItem('customers')).toBeVisible()
    await expect(dg.treeItem('Mixed Case Table')).toBeVisible()
    await dg.shot('postgres-tree')

    await dg.createConnection('mssql', { test: true })
    // The SQL Server tree reveals datagrippe_test › dbo; its Tables folder lists the seeded tables.
    await dg.treeItem(ENGINES.mssql.defaultSchema).click()
    const mssqlTables = dg.tree.getByRole('treeitem').filter({ hasText: /^Tables/ }).first()
    await mssqlTables.click()
    await page.keyboard.press('ArrowRight')
    await expect(dg.tree.getByRole('treeitem').filter({ hasText: 'audit_log' }).first()).toBeVisible()
    await dg.shot('both-connected')

    // Status bar follows the explorer selection.
    await dg.treeItem(ENGINES.postgres.name).click()
    await expect(page.locator('footer').getByText(ENGINES.postgres.name)).toBeVisible()

    // Connections (and their encrypted passwords) survive a restart; connecting needs no prompt.
    // (relaunch replaces dg.page)
    await relaunch(dg)
    await expect(dg.treeItem(ENGINES.postgres.name)).toBeVisible()
    await expect(dg.treeItem(ENGINES.mssql.name)).toBeVisible()
    await dg.treeItem(ENGINES.postgres.name).dblclick()
    await expect(dg.treeItem('public')).toBeVisible()
    await expect(dg.page.getByRole('dialog')).toHaveCount(0)
    await dg.shot('after-restart')
  })

  test('reports a failed connection test inline', async ({ dg }) => {
    const { page } = dg
    await dg.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await page.locator('#cd-host').fill('127.0.0.1')
    await page.locator('#cd-port').fill(String(ENGINES.postgres.port))
    await page.locator('#cd-database').fill(ENGINES.postgres.database)
    await page.locator('#cd-user').fill(ENGINES.postgres.user)
    await dialog.getByLabel('Password', { exact: true }).fill('wrong-password')
    await dialog.getByRole('button', { name: 'Test connection' }).click()
    await expect(dialog.getByText(/password authentication failed/i)).toBeVisible()
    await dg.shot('test-failed')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(dialog).toBeHidden()
  })
})

test.describe('passwords', () => {
  test('asks for the password of a connection that does not save it', async ({ dg }) => {
    const e = ENGINES.postgres
    await dg.menu('New connection…')
    const dialog = dg.page.getByRole('dialog')
    await dg.page.locator('#cd-name').fill(e.name)
    await dg.page.locator('#cd-host').fill(e.host)
    await dg.page.locator('#cd-port').fill(String(e.port))
    await dg.page.locator('#cd-database').fill(e.database)
    await dg.page.locator('#cd-user').fill(e.user)
    await dialog.getByRole('switch', { name: 'Save password' }).click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()

    // Connecting prompts; the typed password is used and kept in memory only.
    await dg.treeItem(e.name).dblclick()
    const prompt = dg.page.getByRole('dialog', { name: 'Password required' })
    await expect(prompt).toBeVisible()
    await dg.shot('password-prompt')
    await prompt.getByLabel('Password').fill(e.password)
    await dg.page.keyboard.press('Enter')
    await expect(prompt).toBeHidden()
    await expect(dg.treeItem(e.defaultSchema)).toBeVisible()
    await dg.shot('connected-after-prompt')
  })
})
