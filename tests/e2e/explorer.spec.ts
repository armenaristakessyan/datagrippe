import { expect, test } from './fixtures'

test.describe('explorer', () => {
  test('shows the properties of a column next to its row', async ({ dg }) => {
    const { page } = dg
    const card = (column: string) => page.getByRole('dialog', { name: `Properties of column ${column}` })
    const anyCard = page.getByRole('dialog', { name: /^Properties of column / })

    await dg.createConnection('postgres')
    await dg.expand('Tables')
    await dg.expand('customers')

    // A click shows the column's configuration and opens no tab.
    await dg.treeItem('email').click()
    await expect(card('email')).toBeVisible()
    await expect(card('email')).toContainText('email_address')
    await expect(card('email')).toContainText('customers_email_key')
    await expect(card('email')).toContainText('Primary contact email')
    await expect(page.getByRole('tab', { name: /^customers — / })).toHaveCount(0)
    await dg.shot('column-properties')

    // The tree keeps the focus: the card follows the selection, Escape hides it, Enter shows it again.
    await page.keyboard.press('ArrowDown')
    await expect(card('is_active')).toBeVisible()
    await expect(card('is_active')).toContainText('true')
    await page.keyboard.press('Escape')
    await expect(anyCard).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(card('is_active')).toBeVisible()

    // A second click on the same row hides it; a check constraint shows up on its column.
    await dg.treeItem('is_active').click()
    await expect(anyCard).toHaveCount(0)
    await dg.treeItem('credit_limit').click()
    await expect(card('credit_limit')).toContainText('customers_credit_limit_check')

    // Context menu › Properties, with the primary key and the foreign keys pointing at it.
    await dg.treeItem('id').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Properties/ }).click()
    await expect(card('id')).toContainText('customers_pkey')
    await expect(card('id')).toContainText('← sales.orders.customer_id')
    await expect(card('id')).toContainText('ON DELETE CASCADE')
    await dg.shot('primary-key-properties')

    // Moving to a non-column row closes it.
    await page.keyboard.press('ArrowUp')
    await expect(anyCard).toHaveCount(0)
  })

  test('shows the properties of keys, indexes, foreign keys and triggers', async ({ dg }) => {
    const { page } = dg
    const card = (label: string) => page.getByRole('dialog', { name: `Properties of ${label}` })

    await dg.createConnection('postgres')
    await dg.expand('sales')
    // public is open above: the second "Tables" folder is the one of sales.
    const salesTables = dg.tree.getByRole('treeitem').filter({ has: page.getByText('Tables', { exact: true }) }).nth(1)
    await salesTables.click()
    await page.keyboard.press('ArrowRight')
    await expect(salesTables).toHaveAttribute('aria-expanded', 'true')
    await dg.expand('orders')
    for (const folder of ['Keys', 'Indexes', 'Foreign keys', 'Triggers']) await dg.expand(folder)

    await dg.treeItem('orders_pkey').click()
    await expect(card('primary key orders_pkey')).toContainText('integer')
    await expect(card('primary key orders_pkey')).toContainText('PRIMARY KEY (id)')

    await dg.treeItem('orders_customer_id_fkey').click()
    const fk = card('foreign key orders_customer_id_fkey')
    await expect(fk).toContainText('public.customers')
    await expect(fk).toContainText('customer_id → id')
    await expect(fk).toContainText('CASCADE')
    await dg.shot('foreign-key-properties')

    await dg.treeItem('orders_customer_id_idx').click()
    await expect(card('index orders_customer_id_idx')).toContainText('btree')
    await expect(card('index orders_customer_id_idx')).toContainText('CREATE INDEX orders_customer_id_idx')

    // Moving up onto the Triggers folder row closes it.
    await dg.treeItem('orders_touch_updated_at').click()
    await expect(card('trigger orders_touch_updated_at')).toContainText('BEFORE')
    await expect(card('trigger orders_touch_updated_at')).toContainText('UPDATE')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('dialog', { name: /^Properties of / })).toHaveCount(0)
  })
})
