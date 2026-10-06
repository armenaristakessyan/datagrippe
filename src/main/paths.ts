// userData location. DATAGRIPPE_USER_DATA_DIR (absolute) isolates a profile — used by tests and
// scripts/snap.mjs. Must run before the app is ready.
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'

/** Folder name of the app's data before it was renamed DataGrippe. */
const LEGACY_FOLDER = 'Datagrippe'

/** Resolve (and create) the userData directory. Returns its absolute path. */
export function setupUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DATAGRIPPE_USER_DATA_DIR?.trim()
  if (override) {
    if (!isAbsolute(override)) {
      console.warn(`[paths] DATAGRIPPE_USER_DATA_DIR must be absolute, ignoring "${override}"`)
    } else {
      mkdirSync(override, { recursive: true })
      app.setPath('userData', override)
      return app.getPath('userData')
    }
  }
  // Renamed from "Datagrippe": on a case-sensitive disk the old folder is not "DataGrippe"; keep using it.
  const current = app.getPath('userData')
  const legacy = join(app.getPath('appData'), LEGACY_FOLDER)
  if (current !== legacy && !existsSync(current) && existsSync(legacy)) app.setPath('userData', legacy)
  return app.getPath('userData')
}

export function userDataDir(): string {
  return app.getPath('userData')
}
