// Launch a built app and save a screenshot — handy for visual checks.
// Usage: node scripts/snap.mjs <outDir> <screenshot.png> [userDataDir] [waitMs]
//   outDir: an electron-vite build output (npx electron-vite build --outDir <outDir>)
// The userDataDir isolates connections/settings/workspace from the real app profile.
// A build outside the repo cannot resolve the main bundle's external dependencies (pg, mssql,
// ssh2), so a `node_modules` link to the repo's is created next to such an outDir.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const [outDir = 'out', shot = 'snap.png', userData = join(tmpdir(), 'datagrippe-snap'), waitMs = '1500'] = process.argv.slice(2)
mkdirSync(userData, { recursive: true })

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outside = relative(repo, resolve(outDir)).startsWith('..')
const link = join(resolve(outDir), '..', 'node_modules')
if (outside && !existsSync(link)) symlinkSync(join(repo, 'node_modules'), link, 'dir')

const app = await electron.launch({
  args: [resolve(outDir, 'main/index.js')],
  env: { ...process.env, DATAGRIPPE_USER_DATA_DIR: resolve(userData), DATAGRIPPE_AUTOMATION: '1', ELECTRON_RENDERER_URL: '' },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(Number(waitMs))
await win.screenshot({ path: shot })
const errors = await win.evaluate(() => (window).__datagrippeErrors ?? [])
console.log(JSON.stringify({ screenshot: resolve(shot), errors }))
await app.close()
