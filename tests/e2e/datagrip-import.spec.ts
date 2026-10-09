// Import from DataGrip: data sources copied in DataGrip (⌘C in its Database Explorer) are pasted, read, imported into
// their group, then connect once the password (never imported) is typed.
import { ENGINES, expect, test } from './fixtures'

const e = ENGINES.postgres

/** What DataGrip puts on the clipboard for one PostgreSQL data source of the "PreProd" group. */
const PASTED = [
  '#DataSourceSettings#',
  '#LocalDataSource: Warehouse',
  '#BEGIN#',
  `<data-source source="LOCAL" name="Warehouse" group="PreProd" uuid="00000000-0000-4000-8000-0000000000aa"><database-info product="PostgreSQL" dbms="POSTGRES"/><driver-ref>postgresql</driver-ref><synchronize>true</synchronize><jdbc-driver>org.postgresql.Driver</jdbc-driver><jdbc-url>jdbc:postgresql://${e.host}:${e.port}/${e.database}</jdbc-url><secret-storage>master_key</secret-storage><user-name>${e.user}</user-name></data-source>`,
  '#END#',
  '#DataSourceSettings#',
  '#LocalDataSource: Shop',
  '#BEGIN#',
  '<data-source source="LOCAL" name="Shop" group="PreProd" uuid="00000000-0000-4000-8000-0000000000bb"><database-info product="MySQL" dbms="MYSQL"/><driver-ref>mysql.8</driver-ref><jdbc-url>jdbc:mysql://127.0.0.1:3306/shop</jdbc-url></data-source>',
  '#END#',
].join('\n')

test('imports data sources pasted from DataGrip, then connects with the typed password', async ({ dg }) => {
  const { page } = dg
  await dg.menu('Import from DataGrip…')
  const dialog = page.getByRole('dialog', { name: 'Import from DataGrip' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Read data sources' })).toBeDisabled()
  await dialog.locator('#dg-datagrip-paste').fill(PASTED)
  await dg.shot('pasted')
  await dialog.getByRole('button', { name: 'Read data sources' }).click()

  const list = dialog.getByRole('list', { name: 'DataGrip data sources' })
  await expect(list.locator('section[aria-label="PreProd"]')).toBeVisible()
  await expect(list.getByText('Warehouse', { exact: true })).toBeVisible()
  // MySQL is listed but cannot be imported.
  await expect(list.getByText('MySQL is not supported: only PostgreSQL and SQL Server')).toBeVisible()
  await dg.shot('read')

  await dialog.getByRole('button', { name: /^Import 1 connection/ }).click()
  await expect(dialog).toBeHidden()
  await expect(dg.toast('Imported 1 connection')).toBeVisible()
  await expect(dg.treeItem('PreProd')).toBeVisible()

  // No password was imported: it is asked when the connection opens.
  await dg.treeItem('Warehouse').dblclick()
  const prompt = page.getByRole('dialog', { name: 'Password required' })
  await prompt.getByLabel('Password').fill(e.password)
  await page.keyboard.press('Enter')
  await expect(prompt).toBeHidden()
  await expect(dg.treeItem(e.defaultSchema)).toBeVisible()
  await dg.shot('connected')
})
