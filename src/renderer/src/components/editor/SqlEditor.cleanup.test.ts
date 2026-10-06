// Regression: closing a console crashed the whole UI ("Cannot read properties of undefined (reading
// '_isDisposed')") because SqlEditor registered detached `.dispose` method references as cleanups.
// Monaco's disposables use `this`, so a cleanup must call `d.dispose()` on the object.
import { describe, expect, it } from 'vitest'
import source from './SqlEditor.tsx?raw'

describe('SqlEditor cleanup', () => {
  it('never registers a detached `.dispose` method reference', () => {
    expect(source).toContain('export function SqlEditor')
    // e.g. `editor.addAction({ ... }).dispose,` or `editor.onDidBlurEditorText(fn).dispose)`
    expect(source.match(/\)\.dispose\s*[,)\]]/g) ?? []).toEqual([])
    expect(source.split('\n').filter((line) => /\)\.dispose,\s*$/.test(line))).toEqual([])
  })
})
