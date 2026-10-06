import { describe, expect, it } from 'vitest'
import type { languages } from 'monaco-editor/editor/editor.api.js'
import { language } from 'monaco-editor/languages/definitions/pgsql/pgsql.js'
import { extendPgsqlLanguage } from './grammar'

describe('extendPgsqlLanguage', () => {
  const extended = extendPgsqlLanguage(language)

  it('adds statement keywords missing from the reserved list', () => {
    const keywords = extended.keywords as string[]
    for (const k of ['UPDATE', 'SET', 'INSERT', 'VALUES', 'BY', 'DELETE', 'SELECT', 'FROM']) expect(keywords).toContain(k)
    expect(keywords).not.toContain('NAME')
  })

  it('maps data types to the type token, before keywords', () => {
    expect(extended.pgTypes).toContain('INTEGER')
    const rule = (extended.tokenizer.root as languages.IMonarchLanguageRule[]).find(
      (r): r is [RegExp, { cases: Record<string, string> }] => Array.isArray(r) && typeof r[1] === 'object' && r[1] !== null && 'cases' in r[1],
    )
    const keys = Object.keys(rule?.[1].cases ?? {})
    expect(keys.indexOf('@pgTypes')).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf('@pgTypes')).toBeLessThan(keys.indexOf('@keywords'))
  })

  it('leaves the source grammar untouched', () => {
    expect(language.keywords as string[]).not.toContain('UPDATE')
  })
})

describe('word operators', () => {
  it('colour AND / JOIN / LEFT … as keywords in both grammars', async () => {
    const { extendMssqlLanguage } = await import('./grammar')
    const { language: tsql } = await import('monaco-editor/languages/definitions/sql/sql.js')
    for (const grammar of [extendPgsqlLanguage(language), extendMssqlLanguage(tsql)]) {
      expect(grammar.wordOperators).toEqual(expect.arrayContaining(['AND', 'JOIN', 'LEFT', 'IN', 'LIKE', 'IS', 'NOT', 'OR']))
      const rule = (grammar.tokenizer.root as languages.IMonarchLanguageRule[]).find(
        (r): r is [RegExp, { cases: Record<string, string> }] => Array.isArray(r) && typeof r[1] === 'object' && r[1] !== null && 'cases' in r[1],
      )
      const cases = rule?.[1].cases ?? {}
      expect(cases['@wordOperators']).toBe('keyword')
      const keys = Object.keys(cases)
      expect(keys.indexOf('@wordOperators')).toBeLessThan(keys.indexOf('@operators'))
    }
  })
})
