// App shell: keyboard focus after overlays, ⌘W with a dialog open, guards that protect console work,
// the password prompt and the server sessions view.
import { ENGINES, expect, test, type Dg } from './fixtures'

// Run in the renderer, where globalThis is the window (this project has no DOM typings). Types only:
// page.evaluate serializes each function, so the bodies cannot share a helper.
type Doc = { document: { activeElement: { closest(selector: string): unknown; getAttribute(name: string): string | null } | null } }
const activeIsEditor = (dg: Dg) => dg.page.evaluate(() => Boolean((globalThis as unknown as Doc).document.activeElement?.closest('.monaco-editor')))
const activeLabel = (dg: Dg) => dg.page.evaluate(() => (globalThis as unknown as Doc).document.activeElement?.getAttribute('aria-label') ?? null)

test.describe('app shell', () => {
  test('focus returns to the editor after the palette, Go to object, history and settings', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await dg.typeSql('SELECT 1')
    for (const item of ['Command palette…', 'Go to object…', 'Query history', 'Settings…']) {
      await dg.menu(item)
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toBeHidden()
      await expect.poll(() => activeIsEditor(dg), { message: `focus after closing ${item}` }).toBe(true)
    }
    // Running a palette command that moves focus nowhere also gives it back to the editor.
    await dg.menu('Command palette…')
    await page.keyboard.type('Format SQL')
    await page.keyboard.press('Enter')
    await expect.poll(() => activeIsEditor(dg)).toBe(true)
    await page.keyboard.type(' AS typed')
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('AS typed')

    // ⌘W with Settings open closes Settings, not the tab behind it.
    await dg.menu('Settings…')
    await expect(page.getByRole('dialog')).toBeVisible()
    await dg.menu('Close tab')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('tab', { name: /^Query 1 — Console/ })).toBeVisible()
  })

  test('a new console follows the connection just created, and the editor keeps focus after a guard confirm', async ({ dg }) => {
    const e = ENGINES.postgres
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    // A second, production connection created with Save & connect while Query 1 (Local PG) is active.
    await dg.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await page.locator('#cd-name').fill('Prod PG')
    await page.locator('#cd-host').fill(e.host)
    await page.locator('#cd-port').fill(String(e.port))
    await page.locator('#cd-database').fill(e.database)
    await page.locator('#cd-user').fill(e.user)
    await dialog.getByLabel('Password', { exact: true }).fill(e.password)
    await dialog.getByRole('tab', { name: /Advanced/ }).click()
    await dialog.getByRole('switch', { name: 'Production connection' }).click()
    await dialog.getByRole('button', { name: 'Save & connect' }).click()
    await expect(dialog).toBeHidden()
    await expect(dg.treeItem('Prod PG')).toHaveAttribute('aria-expanded', 'true')
    await dg.menu('New console')
    await expect(page.getByRole('navigation', { name: 'Location' })).toContainText('Prod PG')

    // The production guard's confirmation gives the focus back to the editor, answered either way.
    await dg.typeSql('CREATE TEMP TABLE shell_guard (id int); DROP TABLE shell_guard')
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    const confirm = page.getByRole('dialog', { name: /Run destructive statement/ })
    await confirm.getByRole('button', { name: 'Run anyway' }).click()
    await expect(confirm).toBeHidden()
    await expect.poll(() => activeIsEditor(dg)).toBe(true)
    await expect(page.getByRole('contentinfo')).toContainText('2 statements')
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect(confirm).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect.poll(() => activeIsEditor(dg)).toBe(true)

    // Focus commands move between the regions of the window.
    const runCommand = async (title: string) => {
      await dg.menu('Command palette…')
      await page.keyboard.type(title)
      await page.keyboard.press('Enter')
    }
    await runCommand('Focus explorer')
    await expect.poll(() => activeLabel(dg)).toBe('Database explorer')
    await runCommand('Focus editor')
    await expect.poll(() => activeIsEditor(dg)).toBe(true)
  })

  test('disconnecting asks before rolling back an open transaction', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await page.getByRole('radio', { name: 'Manual' }).click()
    await dg.typeSql('CREATE TEMP TABLE shell_tx (id int)')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByText('Transaction open')).toBeVisible()
    await dg.treeItem(ENGINES.postgres.name).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Disconnect' }).click()
    const confirm = page.getByRole('dialog', { name: /roll back 1 open transaction/ })
    await expect(confirm).toBeVisible()
    await dg.shot('disconnect-confirm')
    await confirm.getByRole('button', { name: 'Keep connected' }).click()
    await expect(page.getByText('Transaction open')).toBeVisible()
  })

  test('a wrong password keeps the prompt open with the error', async ({ dg }) => {
    const e = ENGINES.postgres
    const { page } = dg
    await dg.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await page.locator('#cd-name').fill(e.name)
    await page.locator('#cd-host').fill(e.host)
    await page.locator('#cd-port').fill(String(e.port))
    await page.locator('#cd-database').fill(e.database)
    await page.locator('#cd-user').fill(e.user)
    await dialog.getByRole('switch', { name: 'Save password' }).click()
    await dialog.getByRole('button', { name: 'Save & connect' }).click()
    const prompt = page.getByRole('dialog', { name: 'Password required' })
    await prompt.getByLabel('Password').fill('not-the-password')
    await page.keyboard.press('Enter')
    await expect(prompt.getByRole('alert')).toContainText(/password/i)
    await dg.shot('password-wrong')
    await prompt.getByLabel('Password').fill(e.password)
    await page.keyboard.press('Enter')
    await expect(prompt).toBeHidden()
    await expect(dg.treeItem(e.defaultSchema)).toBeVisible()
  })

  test('lists server sessions and cancels another session’s query', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await dg.typeSql('SELECT pg_sleep(60)')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByText('Running').first()).toBeVisible()
    await dg.treeItem(ENGINES.postgres.name).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Show sessions…' }).click()
    const grid = page.getByRole('grid', { name: 'Server sessions' })
    await expect(grid.getByText('SELECT pg_sleep(60)', { exact: false }).first()).toBeVisible()
    await dg.shot('sessions')
    await grid.getByText('SELECT pg_sleep(60)', { exact: false }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Cancel query…' }).click()
    const confirm = page.getByRole('dialog', { name: /Cancel the running query of session/ })
    await confirm.getByRole('button', { name: 'Cancel query' }).click()
    await expect(dg.toast(/Cancelled the query of session/)).toBeVisible()
    await page.getByRole('tab', { name: /^Query 1 — Console/ }).click()
    // The console reports the server-side cancel like its own Cancel button.
    await expect(page.getByText('Query cancelled').first()).toBeVisible()
  })
})
