// Regression: "Run statement" on SQL Server split at blank lines, so a blank line before WHERE ran a
// DELETE on the whole table. statementAtOffset must keep incomplete statements together.
import { describe, expect, it } from 'vitest'
import { statementAtOffset } from './index'

describe('Run statement on SQL Server (statementAtOffset)', () => {
  const at = (sql: string) => {
    const offset = sql.indexOf('|')
    return statementAtOffset(sql.slice(0, offset) + sql.slice(offset + 1), offset, 'mssql')?.text
  }
  it('a blank line before WHERE does not turn a DELETE into a full-table delete', () => {
    expect(at('DELETE FROM dbo.customers|\n\nWHERE id = 42')).toBe('DELETE FROM dbo.customers\n\nWHERE id = 42')
  })
  it('a procedure body without BEGIN … END runs whole (it extends to the end of the batch)', () => {
    expect(at('CREATE PROCEDURE dbo.p AS|\nSET NOCOUNT ON\n\nSELECT 1\nGO')).toBe('CREATE PROCEDURE dbo.p AS\nSET NOCOUNT ON\n\nSELECT 1')
  })
  it('IF … ELSE separated by a blank line is one statement', () => {
    expect(at("IF 1 = 1|\n  PRINT 'a'\n\nELSE\n  PRINT 'b'")).toBe("IF 1 = 1\n  PRINT 'a'\n\nELSE\n  PRINT 'b'")
  })
})
