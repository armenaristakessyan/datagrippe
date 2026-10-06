import { describe, expect, it } from 'vitest'
import { looksLikeConnectionString, parseConnectionString, splitKeyValues, type ParsedConnection } from './connection-string'

function ok(text: string): ParsedConnection {
  const result = parseConnectionString(text)
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`)
  return result.value
}

function err(text: string): string {
  const result = parseConnectionString(text)
  if (result.ok) throw new Error('expected a failure')
  return result.error
}

describe('PostgreSQL URLs', () => {
  it('parses every part', () => {
    expect(ok('postgres://alice:s3cret@db.example.com:6543/shop?sslmode=require')).toEqual({
      dialect: 'postgres',
      host: 'db.example.com',
      port: 6543,
      database: 'shop',
      user: 'alice',
      password: 's3cret',
      sslMode: 'require',
    })
  })

  it('accepts postgresql:// and jdbc:postgresql://', () => {
    expect(ok('postgresql://localhost/app')).toEqual({ dialect: 'postgres', host: 'localhost', database: 'app' })
    expect(ok('jdbc:postgresql://h:5433/x?user=bob&password=pw')).toEqual({
      dialect: 'postgres',
      host: 'h',
      port: 5433,
      database: 'x',
      user: 'bob',
      password: 'pw',
    })
  })

  it('percent-decodes user, password and database', () => {
    const v = ok('postgres://us%40er:p%3Ass%2Fw%40rd@host/my%20db')
    expect(v.user).toBe('us@er')
    expect(v.password).toBe('p:ss/w@rd')
    expect(v.database).toBe('my db')
  })

  it('keeps a password containing @ by splitting on the last @', () => {
    expect(ok('postgres://u:a@b@host/db').password).toBe('a@b')
  })

  it('handles IPv6 hosts and multi-host lists', () => {
    expect(ok('postgres://[::1]:5432/db')).toMatchObject({ host: '::1', port: 5432 })
    expect(ok('postgres://h1:5432,h2:5433/db')).toMatchObject({ host: 'h1', port: 5432 })
  })

  it('maps sslmode values', () => {
    expect(ok('postgres://h/db?sslmode=disable').sslMode).toBe('disable')
    expect(ok('postgres://h/db?sslmode=allow').sslMode).toBe('prefer')
    expect(ok('postgres://h/db?sslmode=prefer').sslMode).toBe('prefer')
    expect(ok('postgres://h/db?sslmode=verify-ca').sslMode).toBe('verify-full')
    expect(ok('postgres://h/db?sslmode=verify-full').sslMode).toBe('verify-full')
    expect(ok('postgres://h/db?ssl=true').sslMode).toBe('require')
    expect(ok('postgres://h/db?sslmode=bogus').sslMode).toBeUndefined()
  })

  it('reads application_name and connect_timeout (seconds)', () => {
    expect(ok('postgres://h/db?application_name=etl&connect_timeout=7')).toMatchObject({
      applicationName: 'etl',
      connectTimeoutMs: 7000,
    })
  })

  it('rejects invalid ports and empty URLs', () => {
    expect(err('postgres://h:99999/db')).toMatch(/port/i)
    expect(err('postgres://')).toMatch(/no host/i)
  })
})

describe('libpq keyword strings', () => {
  it('parses key=value pairs with quoting', () => {
    expect(ok("host=localhost port=5433 dbname=app user=me password='it''s me' sslmode=require")).toEqual({
      dialect: 'postgres',
      host: 'localhost',
      port: 5433,
      database: 'app',
      user: 'me',
      password: "it's me",
      sslMode: 'require',
    })
  })
})

describe('SQL Server ADO.NET strings', () => {
  it('parses Server=host,port and the usual keys', () => {
    expect(ok('Server=tcp:sql.example.com,1444;Database=Sales;User Id=sa;Password=Pa;ss=1;Encrypt=True;TrustServerCertificate=True')).toEqual({
      dialect: 'mssql',
      host: 'sql.example.com',
      port: 1444,
      database: 'Sales',
      user: 'sa',
      password: 'Pa',
      sslMode: 'require',
    })
  })

  it('supports aliases, quoting and named instances', () => {
    expect(ok('Data Source=srv\\SQLEXPRESS;Initial Catalog=hr;UID=bob;PWD="a;b""c";Encrypt=false')).toEqual({
      dialect: 'mssql',
      host: 'srv',
      instanceName: 'SQLEXPRESS',
      database: 'hr',
      user: 'bob',
      password: 'a;b"c',
      sslMode: 'disable',
    })
    expect(ok('Server=srv\\INST,1500;PWD={x}};y}')).toMatchObject({ host: 'srv', instanceName: 'INST', port: 1500, password: 'x};y' })
  })

  it('maps Encrypt / TrustServerCertificate combinations', () => {
    expect(ok('Server=h;Encrypt=True').sslMode).toBe('verify-full')
    expect(ok('Server=h;Encrypt=Strict').sslMode).toBe('verify-full')
    expect(ok('Server=h;TrustServerCertificate=yes').sslMode).toBe('require')
    expect(ok('Server=h;Encrypt=Optional').sslMode).toBe('disable')
    expect(ok('Server=h').sslMode).toBeUndefined()
  })

  it('normalizes local server aliases and reads timeouts', () => {
    expect(ok('Server=(local);Database=x;Connect Timeout=30')).toMatchObject({ host: 'localhost', connectTimeoutMs: 30000 })
    expect(ok('Server=.;Database=x').host).toBe('localhost')
    expect(ok('Server=h;Application Name=Reporting').applicationName).toBe('Reporting')
  })

  it('is case-insensitive on keys and tolerates spaces', () => {
    expect(ok('  server = h , 1433 ; DATABASE = db ; user id = u ')).toMatchObject({ host: 'h', port: 1433, database: 'db', user: 'u' })
  })

  it('reports malformed strings', () => {
    expect(err('Server=h;Password="unterminated')).toMatch(/Unterminated/)
    expect(err('Server=h;Port=abc;oops')).toMatch(/key=value/)
    expect(err('Server=h,99999')).toMatch(/port/i)
  })
})

describe('SQL Server URLs', () => {
  it('parses jdbc:sqlserver:// strings', () => {
    expect(ok('jdbc:sqlserver://db.local:1433;databaseName=app;user=sa;password=pw;encrypt=true;trustServerCertificate=true')).toEqual({
      dialect: 'mssql',
      host: 'db.local',
      port: 1433,
      database: 'app',
      user: 'sa',
      password: 'pw',
      sslMode: 'require',
    })
    expect(ok('jdbc:sqlserver://srv\\INST;databaseName=x')).toMatchObject({ host: 'srv', instanceName: 'INST' })
  })

  it('parses sqlserver:// and mssql:// URLs', () => {
    expect(ok('mssql://sa:pw@127.0.0.1:51433/master?encrypt=false')).toEqual({
      dialect: 'mssql',
      host: '127.0.0.1',
      port: 51433,
      database: 'master',
      user: 'sa',
      password: 'pw',
      sslMode: 'disable',
    })
  })
})

describe('detection', () => {
  it('rejects unknown input', () => {
    expect(err('')).toMatch(/Paste/)
    expect(err('mysql://h/db')).toMatch(/Unsupported scheme/)
    expect(err('just some text')).toMatch(/Unrecognized/)
  })

  it('recognizes connection strings pasted into a host field', () => {
    expect(looksLikeConnectionString('postgres://h/db')).toBe(true)
    expect(looksLikeConnectionString('Server=h;Database=d')).toBe(true)
    expect(looksLikeConnectionString('db.example.com')).toBe(false)
  })
})

describe('splitKeyValues', () => {
  it('keeps = inside unquoted values', () => {
    const map = splitKeyValues('a=b=c;d=e', ';')
    expect(map).toBeInstanceOf(Map)
    if (typeof map === 'string') return
    expect(map.get('a')).toBe('b=c')
    expect(map.get('d')).toBe('e')
  })
})
