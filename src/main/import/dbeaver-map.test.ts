import { describe, expect, it } from 'vitest'
import { parseJdbcUrl } from './dbeaver-jdbc'
import {
  chooseDialect,
  compareCandidates,
  fileContext,
  looksLikeProduction,
  mapConnection,
  nearestConnectionColor,
  parseDbeaverColor,
} from './dbeaver-map'

describe('parseJdbcUrl', () => {
  it('parses pgjdbc URLs', () => {
    expect(parseJdbcUrl('jdbc:postgresql://h.example.internal:5433/my%20db?sslmode=verify-full&ApplicationName=x')).toEqual({
      kind: 'postgres',
      hosts: [{ host: 'h.example.internal', port: 5433 }],
      database: 'my db',
      params: { sslmode: 'verify-full', applicationname: 'x' },
    })
    expect(parseJdbcUrl('jdbc:postgresql://h.example.internal/')).toEqual({ kind: 'postgres', hosts: [{ host: 'h.example.internal' }], params: {} })
    expect(parseJdbcUrl('jdbc:postgresql://[::1]:6000,[fe80::2]/db')?.hosts).toEqual([{ host: '::1', port: 6000 }, { host: 'fe80::2' }])
    expect(parseJdbcUrl('jdbc:postgresql:local_db')).toEqual({ kind: 'postgres', hosts: [], database: 'local_db', params: {} })
    expect(parseJdbcUrl('JDBC:POSTGRESQL://h:99999/db')?.hosts).toEqual([{ host: 'h' }])
  })

  it('parses Microsoft SQL Server URLs', () => {
    expect(parseJdbcUrl('jdbc:sqlserver://;serverName=s.example.cloud;databaseName=agg-prod')).toEqual({
      kind: 'sqlserver',
      hosts: [{ host: 's.example.cloud' }],
      database: 'agg-prod',
      params: { servername: 's.example.cloud', databasename: 'agg-prod' },
    })
    expect(parseJdbcUrl('jdbc:sqlserver://s.example.cloud\\INST:1500;database=x;encrypt=true')).toMatchObject({
      hosts: [{ host: 's.example.cloud', port: 1500 }],
      instanceName: 'INST',
      database: 'x',
      params: { encrypt: 'true' },
    })
    expect(parseJdbcUrl('jdbc:sqlserver://;serverName=s\\NAMED;portNumber=1501;databaseName={a;b}')).toMatchObject({
      hosts: [{ host: 's', port: 1501 }],
      instanceName: 'NAMED',
      database: 'a;b',
    })
    expect(parseJdbcUrl('jdbc:sqlserver://s;instanceName=I2')?.instanceName).toBe('I2')
  })

  it('parses jTDS URLs and ignores other drivers', () => {
    expect(parseJdbcUrl('jdbc:jtds:sqlserver://j.example.internal/inv;instance=X;ssl=request')).toMatchObject({
      kind: 'jtds',
      hosts: [{ host: 'j.example.internal' }],
      database: 'inv',
      instanceName: 'X',
      params: { ssl: 'request' },
    })
    expect(parseJdbcUrl('jdbc:mysql://h:3306/db')).toBeNull()
    expect(parseJdbcUrl(undefined)).toBeNull()
    expect(parseJdbcUrl(42)).toBeNull()
  })
})

describe('colors', () => {
  it('parses DBeaver "r,g,b" and hex colors', () => {
    expect(parseDbeaverColor('247,159,129')).toEqual({ r: 247, g: 159, b: 129 })
    expect(parseDbeaverColor('#00ff00')).toEqual({ r: 0, g: 255, b: 0 })
    expect(parseDbeaverColor('300,0,0')).toBeNull()
    expect(parseDbeaverColor('red')).toBeNull()
    expect(parseDbeaverColor(undefined)).toBeNull()
  })

  it('picks the nearest connection color only when it is obvious', () => {
    expect(nearestConnectionColor('247,159,129')).toBe('red') // DBeaver's default "Production" type
    expect(nearestConnectionColor('255,0,0')).toBe('red')
    expect(nearestConnectionColor('255,140,0')).toBe('orange')
    expect(nearestConnectionColor('240,220,40')).toBe('yellow')
    expect(nearestConnectionColor('196,255,181')).toBe('green') // DBeaver's default "Test" type
    expect(nearestConnectionColor('0,128,255')).toBe('blue')
    expect(nearestConnectionColor('128,0,128')).toBe('purple')
    expect(nearestConnectionColor('128,128,128')).toBe('gray')
    expect(nearestConnectionColor('255,255,255')).toBeNull() // DBeaver's default "Development" type
    expect(nearestConnectionColor('0,0,0')).toBeNull()
    expect(nearestConnectionColor('150,120,110')).toBeNull()
  })
})

describe('looksLikeProduction', () => {
  it('matches prod / production as a word', () => {
    for (const s of ['PROD', 'prod', 'billing-prod', 'SQL SERVER - billing-prod', 'Production', 'prod_eu', 'EU (prod)']) {
      expect(looksLikeProduction(s), s).toBe(true)
    }
    for (const s of ['preprod', 'pre-prod', 'non-prod', 'nonprod', 'product', 'products-db', 'reproduction', 'Staging', '', undefined]) {
      expect(looksLikeProduction(s), String(s)).toBe(false)
    }
  })
})

describe('chooseDialect', () => {
  it('maps PostgreSQL and SQL Server providers, conservatively', () => {
    expect(chooseDialect('postgresql', 'postgres-jdbc')).toEqual({ dialect: 'postgres' })
    expect(chooseDialect('sqlserver', 'microsoft')).toEqual({ dialect: 'mssql' })
    expect(chooseDialect('mssql', '')).toEqual({ dialect: 'mssql' })
    expect(chooseDialect('azure-sql', 'azure')).toEqual({ dialect: 'mssql' })
    expect(chooseDialect('postgresql', 'timescale')).toMatchObject({ dialect: 'postgres', note: expect.stringMatching(/TimescaleDB/) })
    expect(chooseDialect('postgresql', 'redshift')).toEqual({ dialect: null, note: 'Unsupported provider postgresql' })
    expect(chooseDialect('postgresql', 'cockroachdb')).toMatchObject({ dialect: null })
    expect(chooseDialect('sqlserver', 'babelfish')).toMatchObject({ dialect: null })
    expect(chooseDialect('sqlserver', 'jtds_sybase')).toMatchObject({ dialect: null })
    expect(chooseDialect('oracle', 'oracle_thin')).toEqual({ dialect: null, note: 'Unsupported provider oracle' })
    expect(chooseDialect('', '')).toEqual({ dialect: null, note: 'Unsupported provider unknown' })
  })
})

describe('mapConnection', () => {
  const ctx = fileContext('/w/General/.dbeaver/data-sources.json', {})

  it('tolerates a connection without configuration', () => {
    const c = mapConnection('x', { provider: 'postgresql' }, ctx)
    expect(c.input).toMatchObject({ name: 'x', host: 'localhost', port: 5432, database: 'postgres', ssl: { mode: 'prefer' }, color: 'none' })
  })

  it('defaults SQL Server SSL like a new connection and honours encrypt / trust settings', () => {
    const ssl = (cfg: Record<string, unknown>) => mapConnection('m', { provider: 'sqlserver', configuration: { host: 'h', ...cfg } }, ctx).input?.ssl
    expect(ssl({})).toEqual({ mode: 'require' })
    expect(ssl({ properties: { encrypt: 'false' } })).toEqual({ mode: 'disable' })
    expect(ssl({ properties: { encrypt: 'true', trustServerCertificate: 'true' } })).toEqual({ mode: 'require' })
    expect(ssl({ properties: { encrypt: 'strict' } })).toEqual({ mode: 'verify-full' })
    expect(ssl({ 'provider-properties': { sslTrustServerCertificate: 'true' } })).toEqual({ mode: 'require' })
  })

  it('maps PostgreSQL SSL modes from the handler', () => {
    const map = (props: Record<string, unknown>, enabled = true) =>
      mapConnection('p', { provider: 'postgresql', configuration: { host: 'h', handlers: { postgre_ssl: { enabled, properties: props } } } }, ctx)
    expect(map({ sslMode: 'require' }).input?.ssl).toEqual({ mode: 'require' })
    expect(map({ sslMode: 'allow' }).input?.ssl).toEqual({ mode: 'prefer' })
    expect(map({ sslMode: 'disable', sslRootCert: '/ca.pem' }).input?.ssl).toEqual({ mode: 'disable' })
    expect(map({ 'ssl.ca.cert': '/ca.pem' }).input?.ssl).toEqual({ mode: 'verify-full', caPath: '/ca.pem' })
    expect(map({}).input?.ssl).toEqual({ mode: 'require' })
    expect(map({ sslMode: 'weird' }).notes).toContain('Unknown SSL mode "weird": using "prefer"')
    expect(map({ sslMode: 'require' }, false).input?.ssl).toEqual({ mode: 'prefer' })
  })

  it('never reads secret-looking Vault keys', () => {
    const c = mapConnection(
      'v',
      {
        provider: 'postgresql',
        configuration: {
          host: 'h',
          'auth-model': 'vault',
          'auth-properties': { token: 'T1', 'vault-url': 'not a url', 'client_secret': 'S', 'api-key': 'K', 'secret-path': 'kv/data/app' },
        },
      },
      ctx,
    )
    expect(c.input?.vault).toEqual({ address: '', loginMethod: 'oidc', secretPath: 'kv/data/app', revokeOnDisconnect: true })
    expect(JSON.stringify(c)).not.toMatch(/T1|"S"|"K"/)
    expect(c.notes).toContain('Set the Vault address')
  })

  it('does not let the file choose the token method nor a plain-http remote Vault', () => {
    const c = mapConnection(
      'v',
      {
        provider: 'postgresql',
        configuration: {
          host: 'h',
          'auth-model': 'vault',
          'auth-properties': { 'vault.address': 'http://vault.example.internal:8200', 'vault.auth-type': 'token', 'vault.secret-path': 'database/creds/ro' },
        },
      },
      ctx,
    )
    expect(c.input?.vault).toEqual({ address: '', loginMethod: 'oidc', secretPath: 'database/creds/ro', revokeOnDisconnect: true })
    expect(c.notes).toEqual(
      expect.arrayContaining([
        'Vault sign-in method "token" from DBeaver is not applied: using OIDC, choose "Token" yourself if you want it',
        'Vault address "http://vault.example.internal:8200" is not used: Use https:// for a remote Vault server (http:// is only allowed on this machine).',
        'Set the Vault address',
      ]),
    )
    const ui = mapConnection('u', { provider: 'postgresql', configuration: { host: 'h', 'auth-model': 'vault', 'auth-properties': { 'vault.url': 'https://vault.example.cloud/ui/vault/secrets' } } }, ctx)
    expect(ui.input?.vault?.address).toBe('https://vault.example.cloud')
  })

  it('orders by folder, then name', () => {
    const mk = (sourceName: string, sourceFolder?: string) => ({
      sourceId: sourceName,
      sourceFile: 'f',
      sourceName,
      sourceProvider: 'postgresql',
      input: null,
      notes: [],
      ...(sourceFolder ? { sourceFolder } : {}),
    })
    const sorted = [mk('b', 'Z'), mk('a10'), mk('a9'), mk('B', 'A'), mk('a', 'A')].sort(compareCandidates)
    expect(sorted.map((c) => `${c.sourceFolder ?? ''}/${c.sourceName}`)).toEqual(['/a9', '/a10', 'A/a', 'A/B', 'Z/b'])
  })
})
