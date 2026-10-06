// Saving consoles to files: the Save dialog keeps the folder of a console opened from a file, and
// files:writeText only writes in place what the user chose before.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const showSaveDialog = vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePath: undefined as string | undefined }))
vi.mock('electron', () => ({ dialog: { showSaveDialog, showOpenDialog: vi.fn() } }))

const { pickPathProperties, saveText, writeTextInPlace } = await import('./files')

describe('files:saveText for a console opened from a file', () => {
  it('opens the save dialog on the original file (directory kept)', async () => {
    await saveText(null, { defaultName: '/Users/me/projects/reports/monthly.sql', content: 'select 1' })
    const options = showSaveDialog.mock.calls[0]!.at(-1) as { defaultPath?: string }
    expect(options.defaultPath).toBe('/Users/me/projects/reports/monthly.sql')
  })
})

describe('files:writeText (save a console in place)', () => {
  it('writes a file opened in this run, or an existing .sql file, and refuses anything else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-write-'))
    try {
      const known = join(dir, 'new.sql')
      expect(await writeTextInPlace({ path: known, content: 'select 1' }, new Set([known]))).toBe(known)
      expect(readFileSync(known, 'utf8')).toBe('select 1')

      const existing = join(dir, 'old.sql')
      writeFileSync(existing, 'x')
      await writeTextInPlace({ path: existing, content: 'select 2' }, new Set())
      expect(readFileSync(existing, 'utf8')).toBe('select 2')

      const other = join(dir, 'notes.sh')
      writeFileSync(other, 'x')
      await expect(writeTextInPlace({ path: other, content: 'rm -rf' }, new Set())).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
      await expect(writeTextInPlace({ path: 'relative.sql', content: '' }, new Set(['relative.sql']))).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
      const gone = join(dir, 'missing', 'a.sql')
      await expect(writeTextInPlace({ path: gone, content: '' }, new Set([gone]))).rejects.toMatchObject({ info: { kind: 'not-found' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('files:pickPath kinds', () => {
  it('picks a file by default, a folder on request, and both only on macOS', () => {
    expect(pickPathProperties(undefined, 'darwin')).toEqual(['openFile', 'showHiddenFiles'])
    expect(pickPathProperties('folder', 'linux')).toEqual(['openDirectory', 'showHiddenFiles'])
    expect(pickPathProperties('any', 'darwin')).toEqual(['openFile', 'openDirectory', 'showHiddenFiles'])
    expect(pickPathProperties('any', 'win32')).toEqual(['openFile', 'showHiddenFiles'])
    expect(pickPathProperties('bogus', 'darwin')).toEqual(['openFile', 'showHiddenFiles'])
  })
})
