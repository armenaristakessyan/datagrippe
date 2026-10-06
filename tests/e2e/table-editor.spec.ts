import { queryMssql, queryPg } from './db'
import { expect, test, type Dg, type EngineName } from './fixtures'

/** Connect through the dialog and open `<defaultSchema>.customers` from the explorer. */
async function openCustomers(dg: Dg, engine: EngineName): Promise<void> {
  await dg.createConnection(engine)
  await dg.expand('Tables')
  await dg.treeItem('customers').dblclick()
  await expect(dg.page.getByRole('tab', { name: /^customers — Data/ })).toHaveAttribute('aria-selected', 'true')
  await expect(dg.grid.getByRole('gridcell').first()).toBeVisible()
}

/** Double-click the cell showing `from`, type `to`, commit with Enter. */
async function editCell(dg: Dg, from: string, to: string): Promise<void> {
  await dg.grid.getByRole('gridcell', { name: from, exact: true }).dblclick()
  const input = dg.page.locator('input:focus, textarea:focus')
  await expect(input).toHaveValue(from)
  await dg.page.keyboard.press('ControlOrMeta+a')
  await dg.page.keyboard.type(to)
  await dg.page.keyboard.press('Enter')
}

test.describe('table data editor', () => {
  test('edits a PostgreSQL row and submits it', async ({ dg }) => {
    await openCustomers(dg, 'postgres')
    await dg.shot('customers')
    await editCell(dg, 'Alan Turing', 'Alan M. Turing')
    await expect(dg.page.getByText('1 pending change')).toBeVisible()
    await dg.shot('pending-edit')

    await dg.page.getByRole('button', { name: /^Submit/ }).click()
    await expect(dg.toast('1 change applied')).toBeVisible()
    // The reloaded page keeps primary-key order: the edited row stays second.
    await expect(dg.grid.getByRole('row').nth(2)).toContainText('Alan M. Turing')
    await dg.shot('submitted')
    expect(await queryPg<{ name: string }>('SELECT name FROM public.customers WHERE id = 2')).toEqual([{ name: 'Alan M. Turing' }])
  })

  test('edits a SQL Server row and submits it', async ({ dg }) => {
    await openCustomers(dg, 'mssql')
    await editCell(dg, 'Grace Hopper', 'Grace B. Hopper')
    await dg.page.getByRole('button', { name: /^Submit/ }).click()
    await expect(dg.toast('1 change applied')).toBeVisible()
    await dg.shot('submitted')
    expect(await queryMssql<{ full_name: string }>('SELECT full_name FROM dbo.customers WHERE id = 2')).toEqual([{ full_name: 'Grace B. Hopper' }])
  })

  test('asks before closing a table tab with pending changes', async ({ dg }) => {
    await openCustomers(dg, 'postgres')
    await dg.page.getByRole('button', { name: 'Add row' }).click()
    // A pending insert shows dimmed DEFAULT placeholders, not data.
    await expect(dg.grid.getByRole('gridcell', { name: 'DEFAULT', exact: true }).first()).toBeVisible()
    await dg.menu('Close tab')
    const confirm = dg.page.getByRole('alertdialog').or(dg.page.getByRole('dialog'))
    await expect(confirm.getByText(/discard 1 pending change/)).toBeVisible()
    await dg.shot('close-guard')
    await confirm.getByRole('button', { name: 'Keep editing' }).click()
    await expect(dg.page.getByRole('tab', { name: /^customers — Data/ })).toBeVisible()

    await dg.menu('Close tab')
    await dg.page.getByRole('button', { name: 'Discard and close' }).click()
    await expect(dg.page.getByRole('tab', { name: /^customers — Data/ })).toHaveCount(0)
    expect(await queryPg('SELECT count(*)::int AS n FROM public.customers')).toEqual([{ n: 5 }])
  })
})

test.describe('table structure', () => {
  test('shows columns, keys and DDL', async ({ dg }) => {
    await openCustomers(dg, 'mssql')
    await dg.page.getByRole('radio', { name: 'Structure' }).click()
    await expect(dg.page.getByRole('tab', { name: /^customers — Structure/ })).toHaveAttribute('aria-selected', 'true')
    await expect(dg.page.getByText('display_name', { exact: true })).toBeVisible()
    await dg.shot('structure')
    await dg.page.getByRole('tab', { name: /^DDL/ }).click()
    await expect(dg.page.getByRole('code').filter({ hasText: /CREATE TABLE dbo\.customers/ })).toBeVisible()
    await dg.shot('ddl')
  })
})
