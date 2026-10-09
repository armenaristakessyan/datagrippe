// Custom app icons: PNG files the user drops in <userData>/icons, offered in Settings › Appearance next to the
// built-in one (the bundle's icon). "DataGrip Halo.png" becomes the id "datagrip-halo", labelled "DataGrip Halo".
// Nothing of them ships with the app: third-party icons stay on the user's machine.
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { BUILTIN_APP_ICON, isAppIconId, type AppIconInfo } from '@shared/types'

export const ICONS_FOLDER = 'icons'
const MAX_ICON_BYTES = 2 * 1024 * 1024
const MAX_ICONS = 24
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function iconsDir(userDataPath: string): string {
  return join(userDataPath, ICONS_FOLDER)
}

/** Lower-case slug of a file name, accents removed ("Été 2026!.png" → "ete-2026"). */
export function iconId(fileName: string): string {
  return basename(fileName, extname(fileName))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '')
}

interface IconFile {
  id: string
  label: string
  path: string
}

/** The usable PNG files of `dir`, A–Z, one per id; the built-in id is reserved. */
function iconFiles(dir: string): IconFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const seen = new Set<string>([BUILTIN_APP_ICON])
  const out: IconFile[] = []
  const stem = (name: string): string => basename(name, extname(name))
  for (const name of names.sort((a, b) => stem(a).localeCompare(stem(b), 'en', { sensitivity: 'base' }))) {
    if (out.length >= MAX_ICONS) break
    if (extname(name).toLowerCase() !== '.png') continue
    const id = iconId(name)
    if (!isAppIconId(id) || seen.has(id)) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_ICON_BYTES) continue
    } catch {
      continue
    }
    seen.add(id)
    out.push({ id, label: stem(name).trim(), path })
  }
  return out
}

function pngData(path: string): Buffer | null {
  try {
    const data = readFileSync(path)
    return data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? data : null
  } catch {
    return null
  }
}

/** The custom icons, each with its PNG as a data URL for the renderer. */
export function listAppIcons(dir: string): AppIconInfo[] {
  return iconFiles(dir).flatMap((file) => {
    const data = pngData(file.path)
    return data ? [{ id: file.id, label: file.label, dataUrl: `data:image/png;base64,${data.toString('base64')}` }] : []
  })
}

/** Path of the custom icon `id`; undefined for the built-in icon, an unknown id or a file that is not a PNG. */
export function appIconFile(dir: string, id: string): string | undefined {
  const file = iconFiles(dir).find((f) => f.id === id)
  return file && pngData(file.path) ? file.path : undefined
}

export function ensureIconsDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}
