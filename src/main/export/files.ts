// Native file dialogs: save/open SQL text, pick a path, choose an export destination.
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { dialog, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import type { CsvParseOptions, ImportFilePreview, OpenTextResult, SaveTextRequest, WriteTextRequest } from '@shared/types'
import type { PickPathKind } from '@shared/ipc'
import { DriverError } from '../db/errors'
import { previewCsvFile } from '../import/import-csv'
import { EXPORT_FILTERS, type FileExportFormat } from './format'

const MAX_OPEN_BYTES = 50 * 1024 * 1024
const IMPORT_FILTERS = [
  { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
  { name: 'All files', extensions: ['*'] },
]
const SQL_FILTERS = [
  { name: 'SQL', extensions: ['sql'] },
  { name: 'Text', extensions: ['txt'] },
  { name: 'All files', extensions: ['*'] },
]

async function showSave(win: BrowserWindow | null, options: SaveDialogOptions): Promise<string | null> {
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function showOpen(win: BrowserWindow | null, options: OpenDialogOptions): Promise<string | null> {
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export async function saveText(win: BrowserWindow | null, req: SaveTextRequest): Promise<string | null> {
  const name = req.defaultName || 'untitled.sql'
  const path = await showSave(win, {
    // A console opened from a file suggests that file (its folder included); other names are just names.
    defaultPath: isAbsolute(name) ? name : basename(name),
    filters: req.filters?.length ? req.filters : SQL_FILTERS,
  })
  if (!path) return null
  await writeFile(path, req.content, 'utf8')
  return path
}

export async function openText(win: BrowserWindow | null): Promise<OpenTextResult | null> {
  const path = await showOpen(win, { properties: ['openFile'], filters: SQL_FILTERS })
  if (!path) return null
  const info = await stat(path)
  if (info.size > MAX_OPEN_BYTES) throw DriverError.of('invalid-input', `${basename(path)} is too large to open (over 50 MB).`)
  return { path, content: await readFile(path, 'utf8') }
}

const WRITABLE_EXTENSIONS = new Set(['.sql', '.txt'])

/**
 * Save in place a file the user chose before. `known` holds the paths opened or saved through a dialog
 * in this run; a path restored from the workspace (a previous run) is accepted when it is an existing
 * .sql / .txt file. Anything else must go through the save dialog.
 */
export async function writeTextInPlace(req: WriteTextRequest, known: ReadonlySet<string>): Promise<string> {
  const { path, content } = req
  if (typeof path !== 'string' || typeof content !== 'string' || !isAbsolute(path)) {
    throw DriverError.of('invalid-input', 'Choose where to save the file.')
  }
  if (!known.has(path)) {
    const existing = await stat(path).catch(() => null)
    if (!existing?.isFile() || !WRITABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw DriverError.of('invalid-input', `${basename(path)} can only be saved with Save as….`)
    }
  }
  const folder = await stat(dirname(path)).catch(() => null)
  if (!folder?.isDirectory()) throw DriverError.of('not-found', `The folder of ${basename(path)} no longer exists. Use Save as….`)
  await writeFile(path, content, 'utf8')
  return path
}

/** Open dialog for a path setting (hidden files shown). 'any' = file or folder on macOS, a file elsewhere. */
export async function pickPath(win: BrowserWindow | null, title: string, kind?: PickPathKind, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  return showOpen(win, { title, properties: pickPathProperties(kind, platform) })
}

type OpenProperty = 'openFile' | 'openDirectory' | 'showHiddenFiles'

export function pickPathProperties(kind: unknown, platform: NodeJS.Platform): OpenProperty[] {
  if (kind === 'folder') return ['openDirectory', 'showHiddenFiles']
  if (kind === 'any' && platform === 'darwin') return ['openFile', 'openDirectory', 'showHiddenFiles']
  return ['openFile', 'showHiddenFiles']
}

export async function chooseExportFile(win: BrowserWindow | null, defaultName: string, format: FileExportFormat): Promise<string | null> {
  const filter = EXPORT_FILTERS[format]
  const name = basename(defaultName || 'export')
  const defaultPath = filter.extensions.some((ext) => name.toLowerCase().endsWith(`.${ext}`)) ? name : `${name}.${filter.extensions[0]}`
  return showSave(win, { defaultPath, filters: [filter, { name: 'All files', extensions: ['*'] }] })
}

/** Choose a CSV / TSV file and preview it. */
export async function pickImportFile(win: BrowserWindow | null, options?: CsvParseOptions | null): Promise<ImportFilePreview | null> {
  const path = await showOpen(win, { title: 'Import data from CSV', properties: ['openFile'], filters: IMPORT_FILTERS })
  if (!path) return null
  return previewCsvFile(path, options ?? {})
}
