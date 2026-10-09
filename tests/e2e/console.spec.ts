import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Dg } from './fixtures'

/** Pick a suggestion from Monaco's suggest widget by its label. */
async function pickSuggestion(dg: Dg, label: string): Promise<void> {
  // Rows are options labelled "<label>, <detail>, <kind>".
  const row = dg.page.locator('.suggest-widget').getByRole('option', { name: new RegExp(`^${label},`) })
  await expect(row).toBeVisible()
  await row.click()
}

test.describe('SQL console', () => {
  test('autocompletes, runs with the keyboard, exports and lands in history (PostgreSQL)', async ({ dg }, testInfo) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await expect(page.getByRole('tab', { name: /^Query 1 — Console/ })).toHaveAttribute('aria-selected', 'true')
    await expect(dg.editor).toBeVisible()

    await dg.editor.click()
    await page.keyboard.type('SELECT o.id, o.total FROM sales.ord')
    await expect(page.locator('.suggest-widget .monaco-list-row').first()).toBeVisible()
    await dg.shot('suggest-tables')
    await pickSuggestion(dg, 'orders')
    await page.keyboard.type(' o WHERE o.sta')
    await expect(page.locator('.suggest-widget .monaco-list-row').filter({ hasText: 'status' }).first()).toBeVisible()
    await dg.shot('suggest-columns')
    await page.keyboard.press('Enter')
    await page.keyboard.type(" = 'paid' ORDER BY o.id")
    await page.keyboard.press('Escape')
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText("sales.orders o WHERE o.status = 'paid' ORDER BY o.id")

    await page.keyboard.press('ControlOrMeta+Enter')
    const results = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: /Messages/ }) })
    await expect(results.getByRole('tab', { name: /orders/ })).toBeVisible()
    await expect(dg.grid.getByRole('gridcell', { name: '1999.90' })).toBeVisible()
    await expect(page.getByText('2 rows').first()).toBeVisible()
    await dg.shot('results')

    // Export every row to CSV (the native save dialog is stubbed).
    const target = testInfo.outputPath('orders.csv')
    await dg.stubSaveDialog(target)
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: 'Export all rows' }).hover()
    await page.getByRole('menuitem', { name: /^CSV/ }).last().click()
    await expect(dg.toast('Exported 2 rows')).toBeVisible()
    expect(readFileSync(target, 'utf8')).toBe('id,total\r\n1,120.50\r\n5,1999.90\r\n')
    await dg.shot('exported')

    // History has the statement once (exports are not recorded).
    await dg.menu('Query history')
    const history = page.getByRole('dialog', { name: 'Query history' })
    await expect(history).toBeVisible()
    await expect(history.getByText(/FROM sales\.orders o WHERE/)).toHaveCount(1)
    await dg.shot('history')
    await page.keyboard.press('Escape')
    await expect(history).toBeHidden()
  })

  test('runs a SQL Server script with GO batches', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('mssql')
    await dg.menu('New console')
    await dg.typeSql("SELECT TOP 2 id, email FROM dbo.customers ORDER BY id\nGO\nPRINT 'hello from batch 2'\nSELECT COUNT(*) AS n FROM sales.orders\n")
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    const results = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: /Messages/ }) })
    await expect(results.getByRole('tab', { name: /customers/ })).toBeVisible()
    await expect(results.getByRole('tab', { name: /Result 2/ })).toBeVisible()
    await expect(dg.grid.getByRole('gridcell', { name: 'ada@example.com' })).toBeVisible()
    await dg.shot('script-results')
    await results.getByRole('tab', { name: /Messages/ }).click()
    await expect(page.getByTestId('results').getByText('hello from batch 2', { exact: true })).toBeVisible()
    await dg.shot('messages')
  })

  test('manual transactions commit on demand', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await page.getByRole('radio', { name: 'Manual' }).click()
    await dg.typeSql("UPDATE public.customers SET is_active = false WHERE id = 5")
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByRole('button', { name: 'Commit' })).toBeVisible()
    await dg.shot('pending-transaction')
    await page.getByRole('button', { name: 'Commit' }).click()
    await expect(page.getByRole('button', { name: 'Commit' })).toBeHidden()
  })

  test('the editor context menu gets the theme colors', async ({ dg }) => {
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await dg.typeSql('select 1')
    await dg.editor.click({ button: 'right' })
    const menu = dg.page.locator('.monaco-menu-container')
    await expect(menu).toContainText('Run statement')
    // Monaco renders it in a shadow root outside .monaco-editor: without the theme variables it is transparent.
    const background = await menu.evaluate((node) => {
      // Runs in the renderer, where globalThis is the window (this project has no DOM typings).
      type Win = { getComputedStyle(el: unknown): { getPropertyValue(name: string): string } }
      const host = (node as unknown as { getRootNode(): { host: unknown } }).getRootNode().host
      return (globalThis as unknown as Win).getComputedStyle(host).getPropertyValue('--vscode-menu-background')
    })
    expect(background.trim()).not.toBe('')
    await dg.shot('editor-context-menu')
    await dg.page.keyboard.press('Escape')
  })
})

test.describe('palette and theme', () => {
  test('runs commands, jumps to objects and switches theme', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await expect(page.locator('html')).not.toHaveClass(/light/)

    await dg.menu('Command palette…')
    const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await expect(palette).toBeVisible()
    await page.keyboard.type('theme')
    await expect(palette.getByRole('option', { name: /Toggle light \/ dark theme/ })).toBeVisible()
    await dg.shot('palette')
    await page.keyboard.press('Enter')
    await expect(page.locator('html')).toHaveClass(/light/)
    await dg.shot('light-theme')

    await dg.menu('New connection…')
    await expect(page.getByRole('dialog', { name: /New PostgreSQL connection/ })).toBeVisible()
    await dg.shot('connection-dialog-light')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /New PostgreSQL connection/ })).toBeHidden()

    await dg.menu('Go to object…')
    await page.keyboard.type('order_items')
    await expect(palette.getByRole('option', { name: /order_items/ }).first()).toBeVisible()
    await dg.shot('go-to-object')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: /^order_items — Data/ })).toHaveAttribute('aria-selected', 'true')
    await expect(dg.grid.getByRole('gridcell').first()).toBeVisible()
    await dg.shot('order-items-light')

    // The theme is a persisted setting, and so is the app icon: the PNG files of the icons folder join the built-in one.
    mkdirSync(join(dg.userDataDir, 'icons'), { recursive: true })
    copyFileSync(resolve('build/icon.png'), join(dg.userDataDir, 'icons', 'Sample Icon.png'))
    await dg.menu('Settings…')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true')
    await settings.getByRole('radio', { name: /Dark/ }).click()
    await expect(page.locator('html')).not.toHaveClass(/light/)
    await dg.shot('settings')

    await expect(settings.getByRole('radio', { name: 'DataGrippe', exact: true })).toHaveAttribute('aria-checked', 'true')
    await settings.getByRole('radio', { name: 'Sample Icon' }).click()
    await expect(settings.getByRole('radio', { name: 'Sample Icon' })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => readFileSync(join(dg.userDataDir, 'settings.json'), 'utf8')).toMatch(/"appIcon":\s*"sample-icon"/)
  })
})
