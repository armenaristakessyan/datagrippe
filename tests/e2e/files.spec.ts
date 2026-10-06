// Files: importing a CSV into a table, and saving a console opened from a .sql file in place (Cmd+S).
// Native open dialogs cannot be driven headlessly: they are stubbed to return the prepared file (written in the
// test's own HOME under test-results/, so nothing is left in the system temp folder).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryPg } from './db'
import { expect, test, type Dg } from './fixtures'

async function stubOpenDialog(dg: Dg, path: string): Promise<void> {
  await dg.app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as unknown as typeof dialog.showOpenDialog
  }, path)
}

test.describe('files', () => {
  test('imports a CSV file into a table, mapping columns by name', async ({ dg }) => {
    const { page } = dg
    await queryPg('DROP TABLE IF EXISTS public.e2e_import')
    await queryPg('CREATE TABLE public.e2e_import (id int PRIMARY KEY, name text NOT NULL, score numeric(6,2), created_at timestamptz DEFAULT now())')
    const dir = mkdtempSync(join(dg.homeDir, 'csv-'))
    const csv = join(dir, 'people.csv')
    writeFileSync(csv, 'ID;Name;Score\n1;Ada;9.5\n2;"Grace; the admiral";8\n3;Linus;\n')
    await stubOpenDialog(dg, csv)

    await dg.createConnection('postgres')
    await dg.expand('Tables')
    await dg.treeItem('e2e_import').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Import data from CSV…' }).click()

    const dialog = page.getByRole('dialog', { name: /Import into/ })
    await expect(dialog).toBeVisible()
    // The ';' delimiter and the header line were detected; columns were matched case-insensitively.
    await expect(dialog.getByRole('cell', { name: 'Grace; the admiral' })).toBeVisible()
    await expect(dialog.getByText('3 columns mapped')).toBeVisible()
    await dg.shot('import-dialog')
    await dialog.getByRole('button', { name: 'Import' }).click()
    await expect(dg.toast('Imported 3 rows into e2e_import')).toBeVisible()
    await expect(dialog).toBeHidden()
    expect(await queryPg('SELECT id, name, score::text AS score FROM public.e2e_import ORDER BY id')).toEqual([
      { id: 1, name: 'Ada', score: '9.50' },
      { id: 2, name: 'Grace; the admiral', score: '8.00' },
      { id: 3, name: 'Linus', score: null },
    ])
  })

  test('saves a console opened from a .sql file in place', async ({ dg }) => {
    const { page } = dg
    const dir = mkdtempSync(join(dg.homeDir, 'sql-'))
    const file = join(dir, 'report.sql')
    writeFileSync(file, 'SELECT 1 AS one\n')
    await dg.createConnection('postgres')
    await stubOpenDialog(dg, file)
    await dg.menu('Open file…')
    await expect(page.getByRole('tab', { name: /^report\.sql/ })).toHaveAttribute('aria-selected', 'true')
    await dg.typeSql('SELECT 2 AS two')
    // A save dialog would hang the test: it must not be shown for a file that is already known.
    await dg.app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error('The save dialog should not open')
      }) as unknown as typeof dialog.showSaveDialog
    })
    await dg.menu('Save')
    await expect(dg.toast('Saved report.sql')).toBeVisible()
    expect(readFileSync(file, 'utf8')).toBe('SELECT 2 AS two')
  })
})
