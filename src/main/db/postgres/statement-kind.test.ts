import { describe, expect, it } from 'vitest'
import { backendKeyOf, cancelRequestPacket } from './cancel'
import { isCopyStdio, noTransactionBlockCommand } from './statement-kind'

describe('isCopyStdio', () => {
  it('detects client-side COPY streams', () => {
    expect(isCopyStdio('COPY public.customers TO STDOUT')).toBe(true)
    expect(isCopyStdio('copy t from stdin with (format csv)')).toBe(true)
    expect(isCopyStdio('COPY (SELECT 1) TO STDOUT WITH CSV HEADER')).toBe(true)
    expect(isCopyStdio('COPY t (a, b) FROM STDIN')).toBe(true)
  })

  it('ignores stdin / stdout inside strings, identifiers, comments and sub-queries', () => {
    expect(isCopyStdio(`COPY (SELECT 1) TO '/tmp/stdout.csv'`)).toBe(false)
    expect(isCopyStdio(`COPY (SELECT 'stdin') TO '/tmp/x'`)).toBe(false)
    expect(isCopyStdio(`COPY t ("stdin") FROM '/tmp/x'`)).toBe(false)
    expect(isCopyStdio(`COPY t TO '/tmp/x' -- not to stdout`)).toBe(false)
    expect(isCopyStdio(`COPY t FROM PROGRAM 'cat stdin'`)).toBe(false)
    expect(isCopyStdio('SELECT 1 AS stdout')).toBe(false)
  })
})

describe('noTransactionBlockCommand', () => {
  it('recognises commands PostgreSQL refuses inside a transaction block', () => {
    const cases: Record<string, string> = {
      'VACUUM rv.t': 'VACUUM',
      'vacuum (verbose, analyze)': 'VACUUM',
      'CREATE DATABASE x': 'CREATE DATABASE',
      'drop database if exists x': 'DROP DATABASE',
      'CREATE INDEX CONCURRENTLY i ON t (a)': 'CREATE INDEX CONCURRENTLY',
      'CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)': 'CREATE INDEX CONCURRENTLY',
      'DROP INDEX CONCURRENTLY i': 'DROP INDEX CONCURRENTLY',
      'REINDEX (VERBOSE) TABLE CONCURRENTLY t': 'REINDEX CONCURRENTLY',
      'REINDEX DATABASE app': 'REINDEX DATABASE',
      "ALTER SYSTEM SET work_mem = '64MB'": 'ALTER SYSTEM',
      'ALTER DATABASE app SET TABLESPACE fast': 'ALTER DATABASE … SET TABLESPACE',
      "CREATE TABLESPACE fast LOCATION '/ssd'": 'CREATE TABLESPACE',
      'DROP TABLESPACE fast': 'DROP TABLESPACE',
      'DISCARD ALL': 'DISCARD ALL',
      CLUSTER: 'CLUSTER',
      'CLUSTER VERBOSE': 'CLUSTER',
      'ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY': 'DETACH PARTITION CONCURRENTLY',
      "CREATE SUBSCRIPTION s CONNECTION 'x' PUBLICATION p": 'CREATE SUBSCRIPTION',
    }
    for (const [sql, label] of Object.entries(cases)) expect(noTransactionBlockCommand(sql), sql).toBe(label)
  })

  it('leaves transactional commands alone', () => {
    for (const sql of [
      'SELECT 1',
      'CREATE INDEX i ON t (a)',
      'REINDEX TABLE t',
      'DROP INDEX i',
      'ANALYZE t',
      'CLUSTER t USING i',
      'DISCARD TEMP',
      "ALTER DATABASE app SET search_path = 'x'",
      'ALTER TABLE p DETACH PARTITION p1',
      'CALL do_work()',
      `SELECT 'VACUUM'`,
      '-- VACUUM\nSELECT 1',
      'CREATE TABLE concurrently (x int)',
    ]) {
      expect(noTransactionBlockCommand(sql), sql).toBeNull()
    }
  })
})

describe('cancel request', () => {
  it('encodes the CancelRequest packet', () => {
    const packet = cancelRequestPacket({ processId: 4242, secretKey: -123456 })
    expect(packet).toHaveLength(16)
    expect(packet.readInt32BE(0)).toBe(16)
    expect(packet.readInt32BE(4)).toBe(80877102)
    expect(packet.readInt32BE(8)).toBe(4242)
    expect(packet.readInt32BE(12)).toBe(-123456)
  })

  it('reads the backend key a pg client stored', () => {
    expect(backendKeyOf({ processID: 7, secretKey: 9 })).toEqual({ processId: 7, secretKey: 9 })
    expect(backendKeyOf({ processID: null, secretKey: null })).toBeNull()
  })
})
