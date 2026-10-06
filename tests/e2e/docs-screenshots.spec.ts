// README screenshots (docs/screenshots/*.png), refreshed from the built app against the docker test databases
// and the dev Vault. Skipped unless DATAGRIPPE_DOCS_SCREENSHOTS=1:
//   npm run build && DATAGRIPPE_DOCS_SCREENSHOTS=1 npx playwright test docs-screenshots
// The Vault picture uses its own, nicely named dev Vault objects (database/creds/shop-readonly, userpass user
// jane.doe), created here and removed afterwards. The DBeaver picture uses a sanitized workspace in the app's own
// HOME (example.cloud hosts only): never the developer's real DBeaver workspace.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TEST_PG, TEST_VAULT } from '../test-env'
import { vaultApi } from '../setup/vault'
import { ENGINES, expect, test, type Dg, type EngineName } from './fixtures'
import { dbeaverWorkspace, requireVault, selectOption } from './vault'

const OUT = resolve(__dirname, '../../docs/screenshots')

test.skip(process.env.DATAGRIPPE_DOCS_SCREENSHOTS !== '1', 'Set DATAGRIPPE_DOCS_SCREENSHOTS=1 to refresh the README screenshots.')

async function save(dg: Dg, name: string, options: { keepFocus?: boolean } = {}): Promise<void> {
  // No transient toast ("Connection saved") and no blinking caret in the picture.
  await expect(dg.page.locator('[data-sonner-toast]')).toHaveCount(0, {
    timeout: 15_000,
  })
  if (!options.keepFocus)
    await dg.page.evaluate(() => (globalThis as { document?: { activeElement?: { blur?: () => void } } }).document?.activeElement?.blur?.())
  // Hover away from buttons and let animations settle.
  await dg.page.mouse.move(1439, 899)
  await dg.page.waitForTimeout(400)
  mkdirSync(OUT, { recursive: true })
  await dg.page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** Open the command palette and type `text` once its input has the focus. */
async function palette(dg: Dg, text: string): Promise<void> {
  await dg.menu('Command palette…')
  await expect(dg.page.getByRole('combobox').filter({ visible: true }).first()).toBeFocused()
  await dg.page.keyboard.type(text)
}

async function setTheme(dg: Dg, theme: 'light' | 'dark'): Promise<void> {
  const html = dg.page.locator('html')
  const isLight = /\blight\b/.test((await html.getAttribute('class')) ?? '')
  if (isLight === (theme === 'light')) return
  await palette(dg, 'Toggle light')
  await expect(dg.page.getByRole('option', { name: /Toggle light/ })).toBeVisible()
  await dg.page.keyboard.press('Enter')
  if (theme === 'light') await expect(html).toHaveClass(/light/)
  else await expect(html).not.toHaveClass(/light/)
}

/** Create "Shop · PostgreSQL" / "Shop · SQL Server" through the dialog and connect. */
async function shop(dg: Dg, engine: EngineName): Promise<string> {
  const e = ENGINES[engine]
  const name = `Shop · ${e.label}`
  const { page } = dg
  await dg.menu('New connection…')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: new RegExp(e.label) }).click()
  await page.locator('#cd-name').fill(name)
  await page.locator('#cd-host').fill(e.host)
  await page.locator('#cd-port').fill(String(e.port))
  await page.locator('#cd-database').fill(e.database)
  await page.locator('#cd-user').fill(e.user)
  await dialog.getByLabel('Password', { exact: true }).fill(e.password)
  await dialog.getByRole('button', { name: 'Save & connect' }).click()
  await expect(dialog).toBeHidden()
  await expect(dg.treeItem(e.defaultSchema)).toBeVisible()
  return name
}

async function run(dg: Dg, sql: string, how: 'Run statement' | 'Run script' = 'Run statement'): Promise<void> {
  await dg.typeSql(sql)
  await dg.menu(how)
  await expect(dg.grid.getByRole('gridcell').first()).toBeVisible()
}

async function newConsole(dg: Dg): Promise<void> {
  await dg.menu('New console')
  await expect(dg.editor).toBeVisible()
}

for (const theme of ['dark', 'light'] as const) {
  test(`console-${theme}`, async ({ dg }) => {
    await shop(dg, 'postgres')
    await setTheme(dg, theme)
    await dg.expand('Tables')
    await newConsole(dg)
    await run(
      dg,
      [
        '-- Revenue per customer, best first',
        'SELECT c.name, c.email, count(o.id) AS orders, sum(o.total) AS revenue, max(o.ordered_at) AS last_order',
        'FROM public.customers c',
        'LEFT JOIN sales.orders o ON o.customer_id = c.id',
        'GROUP BY c.id, c.name, c.email',
        'ORDER BY revenue DESC NULLS LAST;',
      ].join('\n'),
    )
    await dg.grid.getByRole('gridcell', { name: 'Ada Lovelace', exact: true }).click()
    await save(dg, `console-${theme}`, { keepFocus: true })
  })
}

test('table-editor-dark', async ({ dg }) => {
  await shop(dg, 'postgres')
  await dg.expand('Tables')
  await dg.treeItem('customers').dblclick()
  await expect(dg.grid.getByRole('gridcell').first()).toBeVisible()
  const edit = async (from: string, to: string) => {
    await dg.grid.getByRole('gridcell', { name: from, exact: true }).dblclick()
    await dg.page.keyboard.press('ControlOrMeta+a')
    await dg.page.keyboard.type(to)
    await dg.page.keyboard.press('Enter')
  }
  await edit('Alan Turing', 'Alan M. Turing')
  await expect(dg.page.getByText('1 pending change')).toBeVisible()
  await dg.grid.getByRole('gridcell', { name: 'Grace Hopper', exact: true }).click()
  await save(dg, 'table-editor-dark', { keepFocus: true })
})

test('structure-light', async ({ dg }) => {
  await shop(dg, 'postgres')
  await setTheme(dg, 'light')
  await dg.treeItem('public').click()
  await dg.page.keyboard.press('ArrowLeft')
  await dg.expand('sales')
  await dg.expand('Tables')
  await dg.treeItem('orders').dblclick()
  await expect(dg.grid.getByRole('gridcell').first()).toBeVisible()
  await dg.page.getByRole('radio', { name: 'Structure' }).click()
  await expect(dg.page.getByText('customer_id', { exact: true }).first()).toBeVisible()
  await save(dg, 'structure-light')
})

test('explain-dark', async ({ dg }) => {
  await shop(dg, 'postgres')
  await newConsole(dg)
  await dg.typeSql(
    [
      'SELECT c.name, o.status, i.product, i.line_total',
      'FROM sales.order_items i',
      'JOIN sales.orders o ON o.id = i.order_id',
      'JOIN public.customers c ON c.id = o.customer_id',
      "WHERE o.status IN ('paid', 'shipped')",
      'ORDER BY i.line_total DESC;',
    ].join('\n'),
  )
  await palette(dg, 'Explain analyze')
  await expect(dg.page.getByRole('option', { name: /^Explain analyze/ })).toBeVisible()
  await dg.page.keyboard.press('Enter')
  await expect(dg.page.getByText('Hash Join').first()).toBeVisible()
  await save(dg, 'explain-dark')
})

test('sql-server-light', async ({ dg }) => {
  await shop(dg, 'mssql')
  await setTheme(dg, 'light')
  await newConsole(dg)
  await run(
    dg,
    [
      'SELECT TOP 5 id, email, full_name, credit_limit, created_at',
      'FROM dbo.customers',
      'ORDER BY id',
      'GO',
      "PRINT 'Orders by status'",
      'SELECT status, COUNT(*) AS orders, SUM(total) AS total',
      'FROM sales.orders',
      'GROUP BY status',
    ].join('\n'),
    'Run script',
  )
  await expect(dg.page.getByRole('tab', { name: /Messages/ })).toBeVisible()
  await save(dg, 'sql-server-light')
})

test('palette-light', async ({ dg }) => {
  await shop(dg, 'postgres')
  await setTheme(dg, 'light')
  await newConsole(dg)
  await run(dg, "SELECT * FROM sales.orders WHERE status = 'paid';")
  await palette(dg, 'exp')
  await expect(dg.page.getByRole('option', { name: /Explain plan/ })).toBeVisible()
  await save(dg, 'palette-light', { keepFocus: true })
})

test('connection-dialog-dark', async ({ dg }) => {
  await shop(dg, 'postgres')
  const { page } = dg
  const e = ENGINES.postgres
  await dg.menu('New connection…')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /PostgreSQL/ }).click()
  await page.locator('#cd-name').fill('Analytics replica')
  await page.locator('#cd-host').fill(e.host)
  await page.locator('#cd-port').fill(String(e.port))
  await page.locator('#cd-database').fill(e.database)
  await page.locator('#cd-user').fill(e.user)
  await dialog.getByLabel('Password', { exact: true }).fill(e.password)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByText('Connected to PostgreSQL')).toBeVisible()
  await save(dg, 'connection-dialog-dark')
})

// ---------------------------------------------------------------------------
// Vault: dedicated dev Vault objects with readable names
// ---------------------------------------------------------------------------

const DOCS_VAULT = {
  dbMount: 'database',
  role: 'shop-readonly',
  userpass: 'userpass',
  user: 'jane.doe',
  password: 'jane-docs-password',
  policy: 'shop-reader',
}
const created: { mount?: boolean; auth?: boolean; deep: string[] } = { deep: [] }

/** Database mounts laid out per instance (the import picture's "Suggest paths from Vault"): listed, never read. */
const DOCS_DEEP_MOUNTS = [
  'gcp/prod/data/pg-orders-prod-7x2k9q1/orders',
  'gcp/prod/data/pg-billing-prod/billing',
  'gcp/prod/data/mssql-ledger-prod/ledger',
  'gcp/staging/data/pg-orders-staging-4k2/orders',
]

async function setUpDocsVault(): Promise<void> {
  const mounts = (await vaultApi<{ data: Record<string, unknown> }>('GET', 'sys/mounts')).data
  if (!(`${DOCS_VAULT.dbMount}/` in mounts)) {
    await vaultApi('POST', `sys/mounts/${DOCS_VAULT.dbMount}`, {
      type: 'database',
    })
    created.mount = true
  }
  const auths = (await vaultApi<{ data: Record<string, unknown> }>('GET', 'sys/auth')).data
  if (!(`${DOCS_VAULT.userpass}/` in auths)) {
    await vaultApi('POST', `sys/auth/${DOCS_VAULT.userpass}`, {
      type: 'userpass',
    })
    created.auth = true
  }
  await vaultApi('POST', `${DOCS_VAULT.dbMount}/config/shop`, {
    plugin_name: 'postgresql-database-plugin',
    connection_url: `postgresql://{{username}}:{{password}}@${TEST_VAULT.pgHost}:${TEST_VAULT.pgPort}/${TEST_PG.database}?sslmode=disable`,
    username: TEST_PG.user,
    password: TEST_PG.password,
    allowed_roles: [DOCS_VAULT.role],
    verify_connection: true,
  })
  await vaultApi('POST', `${DOCS_VAULT.dbMount}/roles/${DOCS_VAULT.role}`, {
    db_name: 'shop',
    creation_statements: [
      `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';`,
      `GRANT CONNECT ON DATABASE "${TEST_PG.database}" TO "{{name}}";`,
      `GRANT USAGE ON SCHEMA public, sales TO "{{name}}";`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public, sales TO "{{name}}";`,
    ],
    revocation_statements: [
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, sales FROM "{{name}}";`,
      `REVOKE USAGE ON SCHEMA public, sales FROM "{{name}}";`,
      `REVOKE CONNECT ON DATABASE "${TEST_PG.database}" FROM "{{name}}";`,
      `DROP ROLE IF EXISTS "{{name}}";`,
    ],
    default_ttl: '1h',
    max_ttl: '24h',
  })
  for (const mount of DOCS_DEEP_MOUNTS) {
    if (`${mount}/` in mounts) continue
    await vaultApi('POST', `sys/mounts/${mount}`, { type: 'database' })
    created.deep.push(mount)
  }
  await vaultApi('PUT', `sys/policies/acl/${DOCS_VAULT.policy}`, {
    policy: [
      `path "${DOCS_VAULT.dbMount}/creds/${DOCS_VAULT.role}" { capabilities = ["read"] }`,
      `path "gcp/*" { capabilities = ["read"] }`,
      `path "sys/leases/renew" { capabilities = ["update"] }`,
      `path "sys/leases/revoke" { capabilities = ["update"] }`,
    ].join('\n'),
  })
  await vaultApi('POST', `auth/${DOCS_VAULT.userpass}/users/${DOCS_VAULT.user}`, {
    password: DOCS_VAULT.password,
    token_policies: [DOCS_VAULT.policy],
    token_ttl: '1h',
  })
}

async function tearDownDocsVault(): Promise<void> {
  await vaultApi('PUT', 'sys/leases/revoke-prefix/' + `${DOCS_VAULT.dbMount}/creds/${DOCS_VAULT.role}`).catch(() => undefined)
  if (created.mount) await vaultApi('DELETE', `sys/mounts/${DOCS_VAULT.dbMount}`).catch(() => undefined)
  else await vaultApi('DELETE', `${DOCS_VAULT.dbMount}/roles/${DOCS_VAULT.role}`).catch(() => undefined)
  if (created.auth) await vaultApi('DELETE', `sys/auth/${DOCS_VAULT.userpass}`).catch(() => undefined)
  else await vaultApi('DELETE', `auth/${DOCS_VAULT.userpass}/users/${DOCS_VAULT.user}`).catch(() => undefined)
  await vaultApi('DELETE', `sys/policies/acl/${DOCS_VAULT.policy}`).catch(() => undefined)
  for (const mount of created.deep.splice(0)) await vaultApi('DELETE', `sys/mounts/${mount}`).catch(() => undefined)
}

test('vault-connection-dark', async ({ dg }) => {
  requireVault()
  await setUpDocsVault()
  try {
    await shop(dg, 'postgres')
    const { page } = dg
    const e = ENGINES.postgres
    await dg.menu('New connection…')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: /PostgreSQL/ }).click()
    await page.locator('#cd-name').fill('Shop · read-only (Vault)')
    await page.locator('#cd-host').fill(e.host)
    await page.locator('#cd-port').fill(String(e.port))
    await page.locator('#cd-database').fill(e.database)
    await dialog.getByRole('radio', { name: 'Vault', exact: true }).click()
    await page.locator('#cd-vault-address').fill(TEST_VAULT.address)
    await selectOption(dg, 'cd-vault-method', 'Userpass')
    await page.locator('#cd-vault-user').fill(DOCS_VAULT.user)
    await page.locator('#cd-vault-password').fill(DOCS_VAULT.password)
    await page.locator('#cd-vault-path').fill(`${DOCS_VAULT.dbMount}/creds/${DOCS_VAULT.role}`)
    await dialog.getByRole('button', { name: 'Fetch credentials' }).click()
    await expect(page.locator('#cd-vault-result')).toContainText('Signed in via userpass')
    // Show the whole Vault section, from the Authentication switch to the Advanced toggle, with nothing of the
    // field above it peeking under the dialog header.
    await dialog.getByText('Authentication', { exact: true }).evaluate((node) => {
      type El = {
        parentElement: El | null
        scrollHeight: number
        clientHeight: number
        scrollTop: number
        scrollIntoView(o: object): void
      }
      const el = node as unknown as El
      el.scrollIntoView({ block: 'start' })
      let box = el.parentElement
      while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement
      if (box) box.scrollTop += 8
    })
    await save(dg, 'vault-connection-dark')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  } finally {
    await tearDownDocsVault()
  }
})

// ---------------------------------------------------------------------------
// DBeaver import: a sanitized workspace in the app's own HOME
// ---------------------------------------------------------------------------

function writeSanitizedWorkspace(homeDir: string): void {
  const vaultAuth = {
    'vault.address': 'https://vault.example.cloud',
    'vault.auth.method': 'oidc',
  }
  const pg = (host: string, database: string, type: string, extra: Record<string, unknown> = {}) => ({
    host,
    port: '5432',
    database,
    url: `jdbc:postgresql://${host}:5432/${database}`,
    configurationType: 'MANUAL',
    type,
    ...extra,
  })
  const file = {
    folders: { Production: {}, Staging: {} },
    'connection-types': {
      prod: {
        name: 'Production',
        color: '255,128,128',
        'confirm-execute': true,
      },
    },
    connections: {
      'postgres-orders': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: 'Orders',
        folder: 'Production',
        configuration: pg('pg-orders.example.cloud', 'orders', 'prod', {
          'auth-model': 'vault',
          'auth-properties': vaultAuth,
        }),
      },
      'postgres-billing': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: 'Billing',
        folder: 'Production',
        configuration: pg('pg-billing.example.cloud', 'billing', 'prod', {
          'auth-model': 'vault',
          'auth-properties': vaultAuth,
        }),
      },
      'sqlserver-ledger': {
        provider: 'sqlserver',
        driver: 'microsoft',
        name: 'Ledger',
        folder: 'Production',
        configuration: {
          host: 'mssql-ledger.example.cloud',
          port: '1433',
          database: 'ledger',
          configurationType: 'MANUAL',
          type: 'prod',
          'auth-model': 'vault',
          'auth-properties': vaultAuth,
        },
      },
      'postgres-orders-staging': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: 'Orders (staging)',
        folder: 'Staging',
        configuration: pg('pg-orders.staging.example.cloud', 'orders', 'dev', {
          'auth-model': 'vault',
          'auth-properties': vaultAuth,
        }),
      },
      'postgres-analytics': {
        provider: 'postgresql',
        driver: 'postgres-jdbc',
        name: 'Analytics sandbox',
        folder: 'Staging',
        configuration: pg('analytics.example.internal', 'sandbox', 'dev', {
          user: 'analyst',
        }),
      },
      'mysql-legacy': {
        provider: 'mysql',
        driver: 'mysql8',
        name: 'Legacy CMS',
        configuration: {
          host: 'cms.example.internal',
          port: '3306',
          database: 'cms',
          configurationType: 'MANUAL',
          type: 'dev',
        },
      },
    },
  }
  const dir = join(dbeaverWorkspace(homeDir), 'General/.dbeaver')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data-sources.json'), JSON.stringify(file, null, 2))
}

test('dbeaver-import-light', async ({ dg }) => {
  requireVault()
  await setUpDocsVault()
  try {
    writeSanitizedWorkspace(dg.homeDir)
    await setTheme(dg, 'light')
    await dg.menu('Import from DBeaver…')
    const dialog = dg.page.getByRole('dialog', { name: 'Import from DBeaver' })
    await expect(dialog.getByText('Orders', { exact: true })).toBeVisible()
    // The automation guard only lets the app reach the local dev Vault.
    await dialog.locator('#dbv-vault-address').fill(TEST_VAULT.address)
    await selectOption(dg, 'dbv-vault-method', 'Userpass')
    await dialog.locator('#dbv-vault-username').fill(DOCS_VAULT.user)
    await dialog.getByRole('button', { name: 'Suggest paths from Vault' }).click()
    const prompt = dg.page.getByRole('dialog', { name: 'Vault password' })
    await expect(prompt).toBeVisible()
    await prompt.getByLabel(/password/i).first().fill(DOCS_VAULT.password)
    await dg.page.keyboard.press('Enter')
    await expect(prompt).toBeHidden()
    await expect(dialog.getByText(/4 of 4 matched/)).toBeVisible()
    await dg.page.mouse.move(0, 0)
    await save(dg, 'dbeaver-import-light')
  } finally {
    await tearDownDocsVault()
  }
})
