import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appIconFile, iconId, listAppIcons } from './app-icons'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])

describe('custom app icons', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-icons-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('names an icon after its file', () => {
    expect(iconId('DataGrip Halo.png')).toBe('datagrip-halo')
    expect(iconId('Été 2026!.PNG')).toBe('ete-2026')
    expect(iconId('  --.png')).toBe('')
  })

  it('lists the PNG files A–Z as data URLs, one per id, the built-in id reserved', () => {
    writeFileSync(join(dir, 'Zebra.png'), PNG)
    writeFileSync(join(dir, 'DataGrip Halo.png'), PNG)
    writeFileSync(join(dir, 'DataGrip.png'), PNG) // sorted by name, not by file name ("DataGrip." > "DataGrip ")
    writeFileSync(join(dir, 'datagrip-halo.png'), PNG) // same id: the first one A–Z wins
    writeFileSync(join(dir, 'DataGrippe.png'), PNG) // the built-in icon's id
    writeFileSync(join(dir, 'notes.txt'), 'not an icon')
    writeFileSync(join(dir, 'Fake.png'), 'not a png')
    writeFileSync(join(dir, 'Huge.png'), Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))
    const icons = listAppIcons(dir)
    expect(icons.map((i) => [i.id, i.label])).toEqual([
      ['datagrip', 'DataGrip'],
      ['datagrip-halo', 'DataGrip Halo'],
      ['zebra', 'Zebra'],
    ])
    expect(icons[0]?.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(appIconFile(dir, 'zebra')).toBe(join(dir, 'Zebra.png'))
    expect(appIconFile(dir, 'fake')).toBeUndefined()
    expect(appIconFile(dir, 'datagrippe')).toBeUndefined()
  })

  it('has nothing to offer without the folder', () => {
    expect(listAppIcons(join(dir, 'missing'))).toEqual([])
  })
})
