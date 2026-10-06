import { describe, expect, it } from 'vitest'
import { findParameters, renderParameter, substituteParameters } from './sql-parameters'

const labels = (sql: string, dialect: 'postgres' | 'mssql' = 'postgres') => findParameters(sql, dialect).parameters.map((p) => p.label)

describe('findParameters', () => {
  it('finds named, positional, JDBC and template placeholders', () => {
    expect(labels('select * from customers where id = :customer_id and tenant = ${tenant}')).toEqual([':customer_id', '${tenant}'])
    expect(labels('select * from t where a = $1 and b = $2 or a = $1')).toEqual(['$1', '$2'])
    expect(findParameters('insert into t values (?, ?)', 'postgres').parameters.map((p) => p.key)).toEqual(['?1', '?2'])
  })

  it('counts repeated names once', () => {
    const scan = findParameters('select :id, :id + 1', 'postgres')
    expect(scan.parameters).toEqual([{ key: ':id', label: ':id', style: 'named', occurrences: 2 }])
    expect(scan.occurrences).toHaveLength(2)
  })

  it('ignores strings, comments, quoted identifiers and dollar-quoted bodies', () => {
    expect(labels("select ':x', \":y\" from t -- :z\n/* $1 ? */ where a = 'b?' and c = $$ :w $$")).toEqual([])
  })

  it('ignores casts, assignments, slices and PostgreSQL jsonb operators', () => {
    expect(labels('select a::int, b[1:n], c ? \'key\', d ?| array[\'x\'], e ?& f from t')).toEqual([])
    expect(labels('do $$ begin x := 1; end $$')).toEqual([])
  })

  it('ignores the arguments of routine definitions and PREPARE', () => {
    expect(labels('create function f(int) returns int language sql begin atomic select $1 + 1; end')).toEqual([])
    expect(labels('prepare p as select * from t where id = $1')).toEqual([])
  })

  it('SQL Server: undeclared @variables are parameters, declared ones and @@globals are not', () => {
    expect(labels('declare @limit int = 10\nselect top (@limit) * from dbo.t where tenant = @tenant and @@rowcount > 0', 'mssql')).toEqual(['@tenant'])
    expect(labels('declare @a int, @b int; select @a = 1, @b = 2', 'mssql')).toEqual([])
  })

  it('SQL Server: EXEC named arguments are not parameters, their values are', () => {
    expect(labels('exec dbo.find_customer @id = @customer', 'mssql')).toEqual(['@customer'])
  })

  it('SQL Server: procedure definitions declare their own @parameters', () => {
    expect(labels('create procedure dbo.p @id int as select * from t where id = @id', 'mssql')).toEqual([])
  })
})

describe('substitution', () => {
  it('renders numbers as typed, text as quoted literals, SQL verbatim and NULL', () => {
    expect(renderParameter({ mode: 'value', text: '42' }, 'postgres')).toBe('42')
    expect(renderParameter({ mode: 'value', text: "O'Brien" }, 'postgres')).toBe("'O''Brien'")
    expect(renderParameter({ mode: 'value', text: 'x' }, 'mssql')).toBe("N'x'")
    expect(renderParameter({ mode: 'sql', text: 'now()' }, 'postgres')).toBe('now()')
    expect(renderParameter({ mode: 'null', text: 'ignored' }, 'postgres')).toBe('NULL')
    expect(renderParameter(undefined, 'postgres')).toBe('NULL')
  })

  it('replaces every occurrence', () => {
    const sql = 'select * from t where id = :id or parent = :id and name = ?'
    const scan = findParameters(sql, 'postgres')
    expect(substituteParameters(sql, scan, { ':id': { mode: 'value', text: '7' }, '?1': { mode: 'value', text: 'a' } }, 'postgres')).toBe(
      "select * from t where id = 7 or parent = 7 and name = 'a'",
    )
  })
})
