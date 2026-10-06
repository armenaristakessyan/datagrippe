// HashiCorp Vault authentication (dev Vault of docker-compose.test.yml, objects of tests/setup/vault.ts):
// a connection made in the dialog gets dynamic database users from Vault, shows its lease, prompts for the
// Vault password when it is not saved, and revokes its lease on disconnect. The OIDC browser sign-in card
// is driven by faked Vault events (a real identity provider is out of reach of the tests).
import { queryPg } from './db'
import { ENGINES, expect, relaunch, test, type Dg } from './fixtures'
import { answerVaultPassword, contextAction, leaseIds, newLeases, requireVault, runScalar, selectOption, VAULT } from './vault'

const NAME = 'Vault PG'

/** Fill the connection dialog for a PostgreSQL connection whose credentials come from Vault (userpass). */
async function fillVaultConnection(dg: Dg, secretPath: string): Promise<void> {
  const { page } = dg
  const e = ENGINES.postgres
  await dg.menu('New connection…')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: /PostgreSQL/ }).click()
  await page.locator('#cd-name').fill(NAME)
  await page.locator('#cd-host').fill(e.host)
  await page.locator('#cd-port').fill(String(e.port))
  await page.locator('#cd-database').fill(e.database)
  await dialog.getByRole('radio', { name: 'Vault', exact: true }).click()
  await page.locator('#cd-vault-address').fill(VAULT.address)
  await selectOption(dg, 'cd-vault-method', 'Userpass')
  await page.locator('#cd-vault-mount').fill(VAULT.userpassMount)
  await page.locator('#cd-vault-user').fill(VAULT.readerUser)
  await page.locator('#cd-vault-password').fill(VAULT.readerPassword)
  await page.locator('#cd-vault-path').fill(secretPath)
}

test.describe('Vault', () => {
  test.beforeEach(() => requireVault())

  test('connects with dynamic credentials from the connection dialog and revokes them on disconnect', async ({ dg }) => {
    const { page } = dg
    const before = await leaseIds(VAULT.pgRole)
    const dialog = page.getByRole('dialog')

    // A wrong secret path is reported as a Vault error.
    await fillVaultConnection(dg, `${VAULT.dbMount}/creds/no-such-role`)
    await dialog.getByRole('button', { name: 'Fetch credentials' }).click()
    await expect(page.locator('#cd-vault-result')).toContainText('Vault')
    await dg.shot('fetch-error')

    await page.locator('#cd-vault-path').fill(`${VAULT.dbMount}/creds/${VAULT.pgRole}`)
    await dialog.getByRole('button', { name: 'Fetch credentials' }).click()
    await expect(page.locator('#cd-vault-result')).toContainText('Signed in via userpass')
    await expect(page.locator('#cd-vault-result')).toContainText(/user v-/)
    await dg.shot('fetched')
    await dialog.getByRole('button', { name: 'Test connection' }).click()
    await expect(dialog.getByText('Connected to PostgreSQL')).toBeVisible()
    // The test leases are revoked right away.
    await expect.poll(() => newLeases(VAULT.pgRole, before)).toEqual([])

    // Keep the Vault password in memory only, then save & connect.
    const save = dialog.getByRole('switch', { name: 'Save password' })
    if ((await save.getAttribute('aria-checked')) === 'true') await save.click()
    await dg.shot('vault-dialog')
    await dialog.getByRole('button', { name: 'Save & connect' }).click()
    await expect(dialog).toBeHidden()
    await expect(dg.treeItem('public')).toBeVisible()
    await expect(dg.treeItem(NAME).locator('svg[data-vault-tone="neutral"]')).toBeVisible()
    const user = await runScalar(dg, 'SELECT current_user')
    expect(user).toMatch(/^v-/)
    await expect(page.getByTestId('vault-chip')).toHaveText(/Vault.*(1 h|59 min)/)
    expect(await newLeases(VAULT.pgRole, before)).toHaveLength(1)
    await dg.shot('connected')

    // Palette command on the active Vault connection.
    await dg.menu('Command palette…')
    await page.keyboard.type('Refresh Vault')
    await expect(page.getByRole('option', { name: /Refresh Vault credentials/ })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Vault database user')
    // The lease's user is reachable from the keyboard too (the badge / chip tooltips are hover-only).
    await expect(page.getByRole('option', { name: /Copy Vault database user/ })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Refresh Vault')
    await dg.shot('palette')
    await page.keyboard.press('Enter')
    await expect(dg.toast('Vault credentials refreshed')).toBeVisible()

    // Disconnect revokes the leases: Vault drops the temporary roles.
    await contextAction(dg, NAME, 'Disconnect')
    await expect(page.getByTestId('vault-chip')).toHaveCount(0)
    await expect.poll(() => newLeases(VAULT.pgRole, before)).toEqual([])
    expect(await queryPg('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).toEqual([])

    // The Vault password was not saved: after a restart connecting asks for it (a wrong one keeps the prompt open).
    await relaunch(dg)
    await dg.treeItem(NAME).dblclick()
    const prompt = dg.page.getByRole('dialog', { name: 'Vault password' })
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('kept in memory until you quit')
    // An empty Vault password is not an answer.
    await expect(prompt.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await prompt.getByLabel(/password/i).first().fill('wrong-password')
    await dg.page.keyboard.press('Enter')
    await expect(prompt.getByText(/rejected|invalid/i).first()).toBeVisible()
    await dg.shot('password-prompt-error')
    await answerVaultPassword(dg, VAULT.readerPassword)
    await expect(dg.treeItem('public')).toBeVisible()
    await expect(dg.page.getByTestId('vault-chip')).toBeVisible()

    // Sign out forgets the cached Vault token; the open connection keeps working.
    await contextAction(dg, NAME, 'Sign out of Vault')
    await expect(dg.toast('Signed out of Vault')).toBeVisible()
    await contextAction(dg, NAME, 'Disconnect')
    await expect.poll(() => newLeases(VAULT.pgRole, before)).toEqual([])
  })

  test('keeps the auth mount of each sign-in method and explains the token order', async ({ dg }) => {
    const { page } = dg
    await dg.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: 'Vault', exact: true }).click()
    await selectOption(dg, 'cd-vault-method', 'Userpass')
    await page.locator('#cd-vault-mount').fill(VAULT.userpassMount)
    await selectOption(dg, 'cd-vault-method', 'Vault CLI token')
    // Like DBeaver's Vault plugin: the token of "vault login", with the browser as fallback.
    await expect(dialog).toContainText('The token of “vault login”')
    await expect(dialog.getByRole('switch', { name: /Sign in with the browser when the token is missing or expired/ })).toBeChecked()
    // VAULT_TOKEN and ~/.vault-token win over a typed token (Advanced): the hint says so.
    await dialog.getByRole('button', { name: 'Advanced' }).click()
    await expect(dialog).toContainText('Used only when VAULT_TOKEN and ~/.vault-token (vault login) are missing or rejected.')
    await selectOption(dg, 'cd-vault-method', 'OIDC')
    await expect(page.locator('#cd-vault-mount')).toHaveValue('')
    await selectOption(dg, 'cd-vault-method', 'Userpass')
    await expect(page.locator('#cd-vault-mount')).toHaveValue(VAULT.userpassMount)
  })

  test('shows the browser sign-in card of an OIDC login', async ({ dg }) => {
    const send = (event: Record<string, unknown>) =>
      dg.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('event:vaultLogin', payload), event)
    const server = { address: 'https://vault.example.internal', namespace: 'team-data' }
    const card = dg.page.getByTestId('vault-login-card')

    await send({ ...server, state: 'browser-opened', url: 'https://sso.example.internal/authorize?state=x' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Sign in to Vault in your browser')
    await expect(card).toContainText('https://vault.example.internal · team-data')
    await dg.shot('oidc-card')

    await send({ ...server, state: 'completed' })
    await expect(card).toBeHidden()
    await expect(dg.toast('Signed in to Vault')).toBeVisible()
    await dg.shot('oidc-completed')

    // Cancel asks main to abort the pending sign-in (none here) and closes the card.
    await send({ ...server, state: 'browser-opened', url: 'https://sso.example.internal/authorize?state=y' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(card).toBeHidden()
  })
})
