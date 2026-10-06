// Console lifecycle: closing consoles (the fixture fails the test on any renderer error), closing one
// with an open transaction, and query parameters.
import { expect, test } from './fixtures'
import { queryPg } from './db'

test.describe('console lifecycle', () => {
  test('closes consoles from the menu and the tab button without crashing', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await dg.menu('New console')
    await expect(page.getByRole('tab', { name: /^Query 2 — Console/ })).toHaveAttribute('aria-selected', 'true')
    await dg.typeSql('SELECT 1 AS one')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(dg.grid.getByRole('gridcell', { name: '1' }).first()).toBeVisible()

    await dg.menu('Close tab')
    await expect(page.getByRole('tab', { name: /^Query 2 — Console/ })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^Query 1 — Console/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Something went wrong')).toHaveCount(0)

    await dg.menu('Close tab')
    await expect(page.getByRole('tab', { name: /— Console/ })).toHaveCount(0)
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await dg.shot('all-consoles-closed')
  })

  test('asks before closing a console with an open transaction', async ({ dg }) => {
    const { page } = dg
    await queryPg('CREATE TABLE IF NOT EXISTS public.e2e_close_tx (id int)')
    await queryPg('TRUNCATE public.e2e_close_tx')
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await page.getByRole('radio', { name: 'Manual' }).click()
    await dg.typeSql('INSERT INTO public.e2e_close_tx VALUES (1)')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByRole('button', { name: 'Commit' })).toBeVisible()

    await dg.menu('Close tab')
    const dialog = page.getByRole('dialog', { name: /open transaction/ })
    await expect(dialog).toBeVisible()
    await dg.shot('close-with-transaction')
    // Cancel (focused) keeps the console and its pending work.
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('tab', { name: /^Query 1 — Console/ })).toBeVisible()

    await dg.menu('Close tab')
    await page.getByRole('dialog', { name: /open transaction/ }).getByRole('button', { name: 'Commit and close' }).click()
    await expect(page.getByRole('tab', { name: /— Console/ })).toHaveCount(0)
    await expect.poll(async () => (await queryPg<{ n: string }>('SELECT count(*)::text AS n FROM public.e2e_close_tx'))[0]?.n).toBe('1')
  })

  test('prompts for query parameters', async ({ dg }) => {
    const { page } = dg
    await dg.createConnection('postgres')
    await dg.menu('New console')
    await dg.typeSql('SELECT :n::int + 1 AS answer')
    await page.keyboard.press('ControlOrMeta+Enter')
    const dialog = page.getByRole('dialog', { name: /query parameter/ })
    await expect(dialog).toBeVisible()
    await page.keyboard.type('41')
    await dg.shot('parameters')
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(dg.grid.getByRole('gridcell', { name: '42' })).toBeVisible()
  })
})
