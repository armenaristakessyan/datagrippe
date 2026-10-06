import { describe, expect, it } from 'vitest'
import type { VaultDiscoverTarget } from '@shared/types'
import { bestSuggestion, credsPath, databaseMounts, scoreMounts, suggestPaths, words } from './discovery'

// A layout like a real one (sanitized): one database secrets engine per instance and database,
// "<cloud>/<env>/<team>/<instance-id>/<database>", role "read_only".
const ANALYTICS = 'gcp/prod/data/pg-analytics-prod-7x2k9q1/warehouse'
const PAYMENTS = 'gcp/prod/data/pg-payments-core-prod/payments-core-prod-acme'
const LEDGER = 'gcp/prod/data/pg-ledger-prod/ledger_db'
const BILLING = 'gcp/prod/data/acme/server'
const mounts = [ANALYTICS, PAYMENTS, LEDGER, BILLING].map((path) => ({ path, type: 'database' }))

const targets: VaultDiscoverTarget[] = [
  { key: 'analytics', dialect: 'postgres', host: 'pg-analytics-database.example.cloud', database: 'warehouse', name: 'PGSQL - Analytics - warehouse' },
  {
    key: 'payments',
    dialect: 'postgres',
    host: 'pg-payments-core-database.example.cloud',
    database: 'payments-import-prod-acme',
    name: 'PGSQL - All Payments DBs - pg-payments-core-database.example.cloud',
  },
  { key: 'ledger', dialect: 'postgres', host: 'pg-ledger-database.example.cloud', database: 'postgres', name: 'PGSQL - Ledger - @pg-ledger-database.example.cloud' },
  // Shares "analytics" with a PostgreSQL mount: the engine must decide.
  { key: 'billing', dialect: 'mssql', host: 'mssql-prod-acme-db.example.cloud', database: 'analytics-prod-acme', name: 'SQL SERVER - analytics-prod-acme' },
]

describe('databaseMounts', () => {
  it('keeps database secrets engines of a sys/internal/ui/mounts answer, without trailing slashes', () => {
    const body = {
      data: {
        secret: {
          'cubbyhole/': { type: 'cubbyhole' },
          'secret/': { type: 'kv', options: { version: '2' } },
          'gcp/prod/data/acme/server/': { type: 'database', description: ' SQL Server ' },
          'gcp/prod/data/pg-ledger-prod/ledger_db/': { type: 'database' },
          broken: 'not an object',
        },
        auth: { 'oidc/': { type: 'oidc' } },
      },
    }
    expect(databaseMounts(body)).toEqual([
      { path: 'gcp/prod/data/acme/server', type: 'database', description: 'SQL Server' },
      { path: 'gcp/prod/data/pg-ledger-prod/ledger_db', type: 'database' },
    ])
    expect(databaseMounts(null)).toEqual([])
    expect(databaseMounts({ data: { secret: [] } })).toEqual([])
  })
})

describe('suggestPaths', () => {
  it('finds the mount of each connection of a DBeaver PROD folder', () => {
    const { suggestions } = suggestPaths(mounts, targets)
    expect(Object.fromEntries(suggestions.map((s) => [s.key, s.path]))).toEqual({
      analytics: `${ANALYTICS}/creds/read_only`,
      payments: `${PAYMENTS}/creds/read_only`,
      ledger: `${LEDGER}/creds/read_only`,
      billing: `${BILLING}/creds/read_only`,
    })
    const analytics = suggestions.find((s) => s.key === 'analytics')
    expect(analytics?.reason).toMatch(/database "warehouse" is the mount name/)
    expect(suggestions.find((s) => s.key === 'billing')?.reason).toMatch(/SQL Server mount/)
  })

  it('lets the engine decide between mounts sharing a word', () => {
    const scored = scoreMounts(mounts, targets[3])
    expect(scored[0].mount).toBe(BILLING)
    expect(scored[0].raw - scored[1].raw).toBeGreaterThan(0.12)
  })

  it('never takes a mount of the other engine, even when it is named after the database', () => {
    const sameName = ['gcp/prod/data/pg-orders-prod/orders', 'gcp/prod/data/acme/server'].map((path) => ({ path, type: 'database' }))
    const target: VaultDiscoverTarget = { key: 'ms', dialect: 'mssql', host: 'db.example.internal', database: 'orders', name: 'SQL SERVER - orders', group: 'PROD' }
    const scored = scoreMounts(sameName, target)
    const pgMount = scored.find((m) => m.mount === 'gcp/prod/data/pg-orders-prod/orders')
    expect(pgMount?.reason).not.toMatch(/is the mount name/)
    // Never suggested: better no suggestion than a PostgreSQL mount for a SQL Server connection.
    expect(bestSuggestion(scored, 'ms')?.mount).not.toBe('gcp/prod/data/pg-orders-prod/orders')
  })

  it('settles prod / staging twins with the environment, and suggests nothing when it is unknown', () => {
    const twins = [ANALYTICS, 'gcp/staging/data/pg-analytics-staging-4k2/warehouse'].map((path) => ({ path, type: 'database' }))
    const base = targets[0]
    expect(suggestPaths(twins, [{ ...base, group: 'PROD' }]).suggestions[0]?.mount).toBe(ANALYTICS)
    expect(suggestPaths(twins, [{ ...base, name: 'Analytics (staging)' }]).suggestions[0]?.mount).toBe(twins[1].path)
    // Nothing says which environment: the user picks.
    const unknown = suggestPaths(twins, [base])
    expect(unknown.suggestions).toEqual([])
    expect(unknown.ranking.analytics.map((r) => r.mount)).toEqual(expect.arrayContaining(twins.map((m) => m.path)))
  })

  it('does not take "prod" for "preprod"', () => {
    const near = [ANALYTICS, 'gcp/preprod/data/pg-analytics-preprod/warehouse'].map((path) => ({ path, type: 'database' }))
    expect(suggestPaths(near, [{ ...targets[0], group: 'PROD' }]).suggestions[0]?.mount).toBe(ANALYTICS)
    expect(suggestPaths(near, [{ ...targets[0], group: 'Preprod' }]).suggestions[0]?.mount).toBe(near[1].path)
  })

  it('suggests nothing for a connection no mount describes', () => {
    const other: VaultDiscoverTarget = { key: 'x', dialect: 'postgres', host: 'crm-db.example.internal', database: 'crm', name: 'CRM' }
    const { suggestions, ranking } = suggestPaths(mounts, [other])
    expect(suggestions).toEqual([])
    expect(ranking.x).toHaveLength(4)
  })

  it('uses the role and caps the ranking', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `gcp/prod/data/pg-svc-${i}/db${i}`, type: 'database' }))
    const { ranking } = suggestPaths(many, [targets[0]], 'readonly', 5)
    expect(ranking.analytics).toHaveLength(5)
    expect(credsPath('gcp/prod/data/acme/server/', 'reporting')).toBe('gcp/prod/data/acme/server/creds/reporting')
    expect(credsPath('a/b', ' ')).toBe('a/b/creds/read_only')
  })

  it('needs a clear winner', () => {
    expect(bestSuggestion([], 'k')).toBeNull()
    const close = [
      { mount: 'a', path: 'a/creds/read_only', score: 0.7, raw: 0.7, reason: '' },
      { mount: 'b', path: 'b/creds/read_only', score: 0.65, raw: 0.65, reason: '' },
    ]
    expect(bestSuggestion(close, 'k')).toBeNull()
    expect(bestSuggestion([{ ...close[0], raw: 1.2, score: 1 }, { ...close[1], raw: 1.1, score: 1 }], 'k')).toBeNull()
    expect(bestSuggestion([{ ...close[0], raw: 1.2, score: 1 }, { ...close[1], raw: 0.6, score: 0.6 }], 'k')?.mount).toBe('a')
  })

  it('splits words on every separator', () => {
    expect(words('PGSQL - All Payments DBs - pg_payments.core')).toEqual(['pgsql', 'all', 'payments', 'dbs', 'pg', 'payments', 'core'])
  })
})
