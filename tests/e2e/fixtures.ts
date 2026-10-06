// Playwright fixtures for the Electron app: one isolated profile per test, renderer error collection
// (any page error or console error fails the test) and helpers for the flows the specs share.
// Every app also gets its own HOME (and no VAULT_* variables), so no test ever reads the developer's
// DBeaver workspace, ~/.vault-token or Vault environment.
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { TEST_MSSQL, TEST_PG } from '../test-env'

const REPO = resolve(__dirname, '../..')
/** The build under test: out/ (npm run test:e2e), or a private one in DATAGRIPPE_E2E_OUT_DIR. */
export const OUT_DIR = process.env.DATAGRIPPE_E2E_OUT_DIR ? resolve(process.env.DATAGRIPPE_E2E_OUT_DIR) : join(REPO, 'out')
const MAIN = join(OUT_DIR, 'main/index.js')

export type EngineName = 'postgres' | 'mssql'

export const ENGINES = {
  postgres: { label: 'PostgreSQL', name: 'Local PG', ...TEST_PG, defaultSchema: 'public' },
  mssql: { label: 'SQL Server', name: 'Local MSSQL', ...TEST_MSSQL, defaultSchema: 'dbo' },
} as const

export class Dg {
  private shotIndex = 0

  constructor(
    public app: ElectronApplication,
    public page: Page,
    readonly userDataDir: string,
    /** HOME of the app (an empty folder per test). */
    readonly homeDir: string,
    readonly errors: string[],
    private readonly shotPrefix: string,
    private readonly shotDir: string,
  ) {}

  /** Screenshot of the window, saved under DATAGRIPPE_SHOTS_DIR (or the test output) and attached to the report. */
  async shot(name: string): Promise<string> {
    const file = join(this.shotDir, `${this.shotPrefix}-${String(++this.shotIndex).padStart(2, '0')}-${name}.png`)
    // Let enter/exit animations (≤150 ms) settle so the picture shows the resting state.
    await this.page.waitForTimeout(250)
    await this.page.screenshot({ path: file })
    await base.info().attach(name, { path: file, contentType: 'image/png' })
    return file
  }

  /** Click a native menu item by label, like the user (Playwright key presses never reach menu accelerators). */
  async menu(label: string): Promise<void> {
    await this.app.evaluate(({ Menu }, wanted) => {
      type Item = { label: string; click: () => void; submenu?: { items: Item[] } | null }
      const find = (items: Item[]): Item | undefined => {
        for (const item of items) {
          if (item.label === wanted) return item
          const nested = item.submenu ? find(item.submenu.items) : undefined
          if (nested) return nested
        }
        return undefined
      }
      const menu = Menu.getApplicationMenu() as unknown as { items: Item[] } | null
      const item = menu ? find(menu.items) : undefined
      if (!item) throw new Error(`No menu item "${wanted}"`)
      item.click()
    }, label)
  }

  /** Native save dialogs resolve to `path` (they cannot be driven headlessly). */
  async stubSaveDialog(path: string): Promise<void> {
    await this.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog
    }, path)
  }

  get tree(): Locator {
    return this.page.getByRole('tree', { name: 'Database explorer' })
  }

  treeItem(label: string): Locator {
    return this.tree.getByRole('treeitem').filter({ has: this.page.getByText(label, { exact: true }) }).first()
  }

  /** The Monaco editor of the visible console. */
  get editor(): Locator {
    return this.page.locator('.monaco-editor:visible').first()
  }

  get grid(): Locator {
    return this.page.getByRole('grid').filter({ visible: true }).first()
  }

  toast(text: string | RegExp): Locator {
    return this.page.locator('[data-sonner-toast]').filter({ hasText: text }).first()
  }

  /** Fill the connection dialog by typing, test it, then Save & connect; waits for the default schema. */
  async createConnection(engine: EngineName, options: { test?: boolean } = {}): Promise<void> {
    const e = ENGINES[engine]
    const { page } = this
    await this.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: new RegExp(e.label) }).click()
    await page.locator('#cd-name').fill(e.name)
    await page.locator('#cd-host').fill(e.host)
    await page.locator('#cd-port').fill(String(e.port))
    await page.locator('#cd-database').fill(e.database)
    await page.locator('#cd-user').fill(e.user)
    await dialog.getByLabel('Password', { exact: true }).fill(e.password)
    if (options.test) {
      await dialog.getByRole('button', { name: 'Test connection' }).click()
      await expect(dialog.getByText(`Connected to ${e.label}`)).toBeVisible()
    }
    await dialog.getByRole('button', { name: 'Save & connect' }).click()
    await expect(dialog).toBeHidden()
    await expect(this.treeItem(e.name)).toHaveAttribute('aria-expanded', 'true')
    await expect(this.treeItem(e.defaultSchema)).toBeVisible()
  }

  /** Expand a folder ("Tables") under the current schema by keyboard, like a user would. */
  async expand(label: string): Promise<void> {
    const row = this.treeItem(label)
    await row.click()
    if ((await row.getAttribute('aria-expanded')) !== 'true') await this.page.keyboard.press('ArrowRight')
    await expect(row).toHaveAttribute('aria-expanded', 'true')
  }

  /** Replace the visible console's text by typing it. */
  async typeSql(sql: string): Promise<void> {
    await this.editor.click()
    await this.page.keyboard.press('ControlOrMeta+a')
    await this.page.keyboard.press('Backspace')
    await this.page.keyboard.type(sql)
    // Close a suggest widget the last keystroke may have opened.
    await this.page.keyboard.press('Escape')
  }

  async expectNoErrors(): Promise<void> {
    // Runs in the renderer; globalThis is its window (this project has no DOM typings).
    const recorded = await this.page.evaluate(() => (globalThis as { __datagrippeErrors?: unknown[] }).__datagrippeErrors ?? [])
    expect([...this.errors, ...recorded.map(String)]).toEqual([])
  }
}

async function launch(userDataDir: string, homeDir: string, errors: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VAULT_')) env[k] = v
  const app = await electron.launch({
    args: [MAIN],
    cwd: REPO,
    env: {
      ...env,
      HOME: homeDir,
      XDG_DATA_HOME: join(homeDir, '.local/share'),
      APPDATA: join(homeDir, 'AppData/Roaming'),
      DATAGRIPPE_USER_DATA_DIR: userDataDir,
      DATAGRIPPE_AUTOMATION: '1',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForLoadState('domcontentloaded')
  // The shell is ready once the welcome screen or the tab strip is there.
  await expect(page.getByRole('tree', { name: 'Database explorer' }).or(page.getByText('No connections yet'))).toBeVisible()
  return { app, page }
}

export const test = base.extend<{ dg: Dg }>({
  dg: async ({}, use, testInfo) => {
    const userDataDir = testInfo.outputPath('userdata')
    rmSync(userDataDir, { recursive: true, force: true })
    mkdirSync(userDataDir, { recursive: true })
    const homeDir = testInfo.outputPath('home')
    rmSync(homeDir, { recursive: true, force: true })
    mkdirSync(homeDir, { recursive: true })
    const shotDir = process.env.DATAGRIPPE_SHOTS_DIR ? resolve(process.env.DATAGRIPPE_SHOTS_DIR) : testInfo.outputPath('shots')
    mkdirSync(shotDir, { recursive: true })
    const prefix = testInfo.titlePath
      .slice(1)
      .join('-')
      .replace(/\.spec\.ts/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const errors: string[] = []
    const { app, page } = await launch(userDataDir, homeDir, errors)
    const dg = new Dg(app, page, userDataDir, homeDir, errors, prefix, shotDir)
    await use(dg)
    try {
      if (testInfo.status === testInfo.expectedStatus) await dg.expectNoErrors()
    } finally {
      await dg.app.close().catch(() => undefined)
    }
  },
})

/** Close the app and start it again on the same profile (persistence checks). */
export async function relaunch(dg: Dg): Promise<void> {
  await dg.app.close()
  const { app, page } = await launch(dg.userDataDir, dg.homeDir, dg.errors)
  dg.app = app
  dg.page = page
}

export { expect }
