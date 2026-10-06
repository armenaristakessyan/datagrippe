// DBeaver connection import: find data-sources*.json files, read them and map every connection to a
// DataGrippe ConnectionInput (see dbeaver-map.ts). Only files named data-sources*.json are ever opened:
// DBeaver's credentials-config*.json (encrypted passwords) and every other file are never read.
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import type { ConnectionConfig, DbeaverImportCandidate, DbeaverScanResult } from '@shared/types'
import { compareCandidates, fileContext, findDuplicate, mapConnection } from './dbeaver-map'

/** Files larger than this are skipped (a DBeaver data-sources file is a few KB per connection). */
export const MAX_DATA_SOURCES_BYTES = 5 * 1024 * 1024

const DATA_SOURCES_FILE = /^data-sources[^/\\]*\.json$/i

export function isDataSourcesFileName(name: string): boolean {
  return DATA_SOURCES_FILE.test(name)
}

/** The file system calls the scanner needs; injectable so tests can observe every access. */
export interface DbeaverFs {
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>
  readdir(path: string): Promise<string[]>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
}

/** Resolved at call time so tests can spy on node:fs. */
const nodeFs: DbeaverFs = {
  stat: (p) => fsp.stat(p),
  readdir: (p) => fsp.readdir(p),
  realpath: (p) => fsp.realpath(p),
  readFile: (p) => fsp.readFile(p),
}

export interface DbeaverScanOptions {
  /** Home directory (default os.homedir()). */
  homeDir?: string
  platform?: NodeJS.Platform
  /** Environment (APPDATA, XDG_DATA_HOME). Default process.env. */
  env?: Record<string, string | undefined>
  fs?: DbeaverFs
}

interface Env {
  homeDir: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  fs: DbeaverFs
}

function environment(options: DbeaverScanOptions): Env {
  return {
    homeDir: options.homeDir ?? homedir(),
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    fs: options.fs ?? nodeFs,
  }
}

/**
 * DBeaver workspace folders to look in, most likely first:
 *  - macOS:   ~/Library/DBeaverData/workspace6
 *  - Windows: %APPDATA%\DBeaverData\workspace6
 *  - Linux:   ${XDG_DATA_HOME:-~/.local/share}/DBeaverData/workspace6, then the Flatpak and Snap sandboxes
 */
export function defaultDbeaverWorkspaceDirs(options: Pick<DbeaverScanOptions, 'homeDir' | 'platform' | 'env'> = {}): string[] {
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'darwin') return [posix.join(homeDir, 'Library', 'DBeaverData', 'workspace6')]
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || win32.join(homeDir, 'AppData', 'Roaming')
    return [win32.join(appData, 'DBeaverData', 'workspace6')]
  }
  const xdg = env.XDG_DATA_HOME?.trim()
  const dataHome = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(homeDir, '.local', 'share')
  return [
    posix.join(dataHome, 'DBeaverData', 'workspace6'),
    posix.join(homeDir, '.var', 'app', 'io.dbeaver.DBeaverCommunity', 'data', 'DBeaverData', 'workspace6'),
    posix.join(homeDir, 'snap', 'dbeaver-ce', 'current', '.local', 'share', 'DBeaverData', 'workspace6'),
  ]
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return 'not found'
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
  return error instanceof Error ? error.message : String(error)
}

async function statOrNull(fs: DbeaverFs, path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number } | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

async function isDirectory(fs: DbeaverFs, path: string): Promise<boolean> {
  return (await statOrNull(fs, path))?.isDirectory() === true
}

async function listNames(fs: DbeaverFs, dir: string, warnings: string[]): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).slice().sort()
  } catch (error) {
    warnings.push(`Could not list ${dir}: ${errorText(error)}`)
    return []
  }
}

/** data-sources*.json files of one .dbeaver folder. */
async function filesInDotDbeaver(fs: DbeaverFs, dir: string, warnings: string[]): Promise<string[]> {
  const out: string[] = []
  for (const name of await listNames(fs, dir, warnings)) {
    if (!isDataSourcesFileName(name)) continue
    const path = join(dir, name)
    if ((await statOrNull(fs, path))?.isFile()) out.push(path)
  }
  return out
}

/** Every <workspace>/<project>/.dbeaver folder. */
async function dotDbeaverDirsInWorkspace(fs: DbeaverFs, workspace: string, warnings: string[]): Promise<string[]> {
  const out: string[] = []
  for (const name of await listNames(fs, workspace, warnings)) {
    const dir = join(workspace, name, '.dbeaver')
    if (await isDirectory(fs, dir)) out.push(dir)
  }
  return out
}

async function filesInWorkspace(fs: DbeaverFs, workspace: string, warnings: string[]): Promise<string[]> {
  const out: string[] = []
  for (const dir of await dotDbeaverDirsInWorkspace(fs, workspace, warnings)) out.push(...(await filesInDotDbeaver(fs, dir, warnings)))
  return out
}

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

/** A data-sources*.json file, a .dbeaver folder, a project folder, a workspace or the DBeaverData folder. */
async function filesForPath(env: Env, rawPath: string, warnings: string[]): Promise<string[]> {
  const expanded = expandHome(rawPath.trim(), env.homeDir)
  const path = isAbsolute(expanded) ? expanded : resolve(expanded)
  const st = await statOrNull(env.fs, path)
  if (!st) {
    warnings.push(`${path} was not found`)
    return []
  }
  if (st.isFile()) {
    if (isDataSourcesFileName(basename(path))) return [path]
    warnings.push(`${basename(path)} is not a DBeaver connections file: choose a data-sources*.json file or a DBeaver folder`)
    return []
  }
  if (!st.isDirectory()) {
    warnings.push(`${path} is not a file or a folder`)
    return []
  }
  let files: string[]
  if (basename(path) === '.dbeaver') files = await filesInDotDbeaver(env.fs, path, warnings)
  else if (await isDirectory(env.fs, join(path, '.dbeaver'))) files = await filesInDotDbeaver(env.fs, join(path, '.dbeaver'), warnings)
  else if (await isDirectory(env.fs, join(path, 'workspace6'))) files = await filesInWorkspace(env.fs, join(path, 'workspace6'), warnings)
  else files = await filesInWorkspace(env.fs, path, warnings)
  if (files.length === 0) warnings.push(`No DBeaver data-sources*.json file found in ${path}`)
  return files
}

async function defaultFiles(env: Env, warnings: string[]): Promise<string[]> {
  const dirs = defaultDbeaverWorkspaceDirs(env)
  const files: string[] = []
  let found = false
  for (const dir of dirs) {
    if (!(await isDirectory(env.fs, dir))) continue
    found = true
    files.push(...(await filesInWorkspace(env.fs, dir, warnings)))
  }
  if (!found) warnings.push(`No DBeaver workspace found (looked in ${dirs.join(', ')})`)
  else if (files.length === 0) warnings.push('No DBeaver connections found in the DBeaver workspace')
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and parse one data-sources file; null (with a warning) when unusable. */
async function readDataSources(fs: DbeaverFs, path: string, warnings: string[]): Promise<Record<string, unknown> | null> {
  const name = basename(path)
  // Defence in depth: the name, and the name of the file a symlink points to, must be data-sources*.json.
  if (!isDataSourcesFileName(name)) return null
  try {
    const real = await fs.realpath(path)
    if (!isDataSourcesFileName(basename(real))) {
      warnings.push(`Skipped ${path}: it links to ${basename(real)}`)
      return null
    }
    const st = await fs.stat(real)
    if (!st.isFile()) return null
    if (st.size > MAX_DATA_SOURCES_BYTES) {
      warnings.push(`Skipped ${path}: larger than ${MAX_DATA_SOURCES_BYTES / 1024 / 1024} MB`)
      return null
    }
    let content = (await fs.readFile(real)).toString('utf8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      warnings.push(`Could not read ${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
      return null
    }
    if (!isRecord(parsed)) {
      warnings.push(`Could not read ${path}: not a DBeaver connections file`)
      return null
    }
    return parsed
  } catch (error) {
    warnings.push(`Could not read ${path}: ${errorText(error)}`)
    return null
  }
}

/**
 * Read DBeaver data-sources*.json files (default workspace when `path` is undefined) and map every
 * connection to a DataGrippe ConnectionInput. Never reads DBeaver's credentials files.
 */
export async function scanDbeaver(
  path: string | undefined,
  existing: readonly ConnectionConfig[],
  options: DbeaverScanOptions = {},
): Promise<DbeaverScanResult> {
  const env = environment(options)
  const warnings: string[] = []
  const located = path !== undefined && path.trim() !== '' ? await filesForPath(env, path, warnings) : await defaultFiles(env, warnings)
  const unique = [...new Set(located)]

  const files: string[] = []
  const candidates: DbeaverImportCandidate[] = []
  for (const file of unique) {
    const root = await readDataSources(env.fs, file, warnings)
    if (!root) continue
    files.push(file)
    const connections = root.connections
    if (connections === undefined) continue
    if (!isRecord(connections)) {
      warnings.push(`Could not read ${file}: "connections" is not an object`)
      continue
    }
    const ctx = fileContext(file, root)
    for (const [id, raw] of Object.entries(connections)) {
      if (!isRecord(raw)) {
        warnings.push(`Skipped connection ${id} in ${file}: invalid entry`)
        continue
      }
      try {
        const candidate = mapConnection(id, raw, ctx)
        if (candidate.input) {
          const duplicateOf = findDuplicate(candidate.input, existing)
          if (duplicateOf) candidate.duplicateOf = duplicateOf
        }
        candidates.push(candidate)
      } catch (error) {
        warnings.push(`Skipped connection ${id} in ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  candidates.sort(compareCandidates)
  return { files, candidates, warnings }
}
