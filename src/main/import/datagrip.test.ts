import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { parseAdoConnectionString } from './dbeaver-jdbc'
import { parseDatagrip } from './datagrip'

// What DataGrip copies to the clipboard (Database Explorer › select › ⌘C), sanitized: one block per data source.
const block = (xml: string) => `#DataSourceSettings#\n#LocalDataSource: x\n#BEGIN#\n${xml}\n#END#\n`

const MSSQL_ADO = block(
  '<data-source source="LOCAL" name="Microsoft SQL Server" group="PreProd" uuid="11111111-0000-4000-8000-000000000001"><database-info product="Microsoft SQL Server" version="16.00.4262" dbms="MSSQL"/><driver-ref>sqlserver.jb</driver-ref><synchronize>true</synchronize><configured-by-url>true</configured-by-url><jdbc-url>data source=ledger-preprod-db.example.cloud;initial catalog=ledger-preprod;persist security info=True;TrustServerCertificate=True;user id=preprod-ledger;password=NotARealSecret1;MultipleActiveResultSets=False;App=LedgerPreprod</jdbc-url><secret-storage>master_key</secret-storage><auth-provider>no-auth</auth-provider><schema-mapping><introspection-scope><node negative="1"><node kind="database" qname="@"><node kind="schema" qname="@"/></node><node kind="database" qname="ledger-preprod"><node kind="schema" negative="1"/></node></node></introspection-scope></schema-mapping></data-source>',
)
const PG_URL = block(
  '<data-source source="LOCAL" name="PostgreSQL" group="PreProd" uuid="11111111-0000-4000-8000-000000000002"><database-info product="PostgreSQL" version="18.4" dbms="POSTGRES"/><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://warehouse-db.preprod.example.cloud:5432/warehouse</jdbc-url><secret-storage>master_key</secret-storage><user-name>app_preprod</user-name><schema-mapping><introspection-scope><node negative="1"><node kind="database" qname="warehouse"><node kind="schema"><name qname="Core"/></node></node></node></introspection-scope></schema-mapping></data-source>',
)
const PG_SCOPED = block(
  '<data-source source="LOCAL" name="import-app" group="PreProd" uuid="11111111-0000-4000-8000-000000000003"><database-info product="PostgreSQL" dbms="POSTGRES"/><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://192.0.2.10:5432/postgres</jdbc-url><user-name>u7Rk2</user-name><schema-mapping><introspection-scope><node negative="1"><node kind="database" qname="@"><node kind="schema" qname="@"/></node><node kind="database" qname="import-preprod"><node kind="schema" negative="1"/></node></node></introspection-scope></schema-mapping></data-source>',
)

describe('parseDatagrip', () => {
  it('maps a SQL Server data source written as an ADO.NET connection string, without its password', () => {
    const { candidates, warnings } = parseDatagrip(MSSQL_ADO, [])
    expect(warnings).toEqual([])
    const [c] = candidates
    expect(c).toMatchObject({ sourceName: 'Microsoft SQL Server', sourceFolder: 'PreProd', sourceFile: 'DataGrip', sourceProvider: 'sqlserver.jb' })
    expect(c?.input).toMatchObject({
      dialect: 'mssql',
      host: 'ledger-preprod-db.example.cloud',
      port: 1433,
      database: 'ledger-preprod',
      user: 'preprod-ledger',
      group: 'PreProd',
      authMode: 'password',
      savePassword: false,
      productionGuard: false,
      ssl: { mode: 'require' },
    })
    expect(c?.notes).toContain('The URL holds a password: it was not imported, enter it when connecting')
    // Never anywhere in what reaches the renderer.
    expect(JSON.stringify(candidates)).not.toContain('NotARealSecret1')
  })

  it('maps a PostgreSQL JDBC URL with its user and group', () => {
    const [c] = parseDatagrip(PG_URL, []).candidates
    expect(c?.input).toMatchObject({ dialect: 'postgres', host: 'warehouse-db.preprod.example.cloud', port: 5432, database: 'warehouse', user: 'app_preprod', group: 'PreProd' })
    expect(c?.notes).toContain('Enter the password when connecting')
  })

  it('opens the one database DataGrip shows when the URL only names postgres', () => {
    const [c] = parseDatagrip(PG_SCOPED, []).candidates
    expect(c?.input).toMatchObject({ host: '192.0.2.10', database: 'import-preprod', user: 'u7Rk2' })
    expect(c?.notes).toContain('Opens import-preprod, the database DataGrip shows (the URL names postgres)')
  })

  it('reads several pasted data sources, sorted by group and name, each once', () => {
    const { candidates } = parseDatagrip(PG_URL + MSSQL_ADO + PG_SCOPED + PG_URL, [])
    expect(candidates.map((c) => c.sourceName)).toEqual(['import-app', 'Microsoft SQL Server', 'PostgreSQL'])
  })

  it('reads SQL Server JDBC URLs, named instances and encryption', () => {
    const xml = block(
      '<data-source name="Billing &amp; co" group="Prod/EU" uuid="u-4"><driver-ref>sqlserver.ms</driver-ref><jdbc-url>jdbc:sqlserver://billing.example.internal\\SQLEXPRESS:14330;databaseName=billing;encrypt=true;trustServerCertificate=false</jdbc-url><user-name>reader</user-name></data-source>',
    )
    const [c] = parseDatagrip(xml, []).candidates
    expect(c?.sourceName).toBe('Billing & co')
    expect(c?.input).toMatchObject({
      dialect: 'mssql',
      host: 'billing.example.internal',
      port: 14330,
      database: 'billing',
      options: { instanceName: 'SQLEXPRESS' },
      ssl: { mode: 'verify-full' },
      productionGuard: true,
      color: 'red',
    })
  })

  it('skips engines DataGrippe does not support', () => {
    const xml = block('<data-source name="Shop" uuid="u-5"><database-info product="MySQL" dbms="MYSQL"/><driver-ref>mysql.8</driver-ref><jdbc-url>jdbc:mysql://shop.example.internal:3306/shop</jdbc-url></data-source>')
    const [c] = parseDatagrip(xml, []).candidates
    expect(c?.input).toBeNull()
    expect(c?.notes).toEqual(['MySQL is not supported: only PostgreSQL and SQL Server'])
  })

  it('flags a data source already saved, and what is not imported', () => {
    const existing = [{ id: 'c1', dialect: 'postgres', host: 'Warehouse-DB.preprod.example.cloud', port: 5432, database: 'warehouse' }] as ConnectionConfig[]
    expect(parseDatagrip(PG_URL, existing).candidates[0]?.duplicateOf).toBe('c1')
    const xml = block(
      '<data-source name="Tunnelled" uuid="u-6"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://db.example.internal/app?sslmode=verify-full</jdbc-url><auth-provider>aws-iam</auth-provider><ssh-properties><enabled>true</enabled><ssh-config-id>x</ssh-config-id></ssh-properties></data-source>',
    )
    const [c] = parseDatagrip(xml, []).candidates
    expect(c?.input).toMatchObject({ database: 'app', user: '', ssl: { mode: 'verify-full' } })
    expect(c?.notes).toEqual(
      expect.arrayContaining([
        'The SSH tunnel is not imported: set it up in the SSH tab',
        'DataGrip authentication "aws-iam" is not imported: using a user name and password',
        'Set the user name (DataGrip keeps it with its saved credentials)',
      ]),
    )
  })

  it('explains what to paste when nothing is recognised', () => {
    expect(parseDatagrip('jdbc:postgresql://db/app', []).warnings[0]).toMatch(/^No DataGrip data source in the pasted text/)
    expect(parseDatagrip('x'.repeat(3 * 1024 * 1024), []).warnings[0]).toMatch(/too large/)
  })
})

describe('parseAdoConnectionString', () => {
  it('reads the server, port, instance, database and user, whatever the case and spacing of the keys', () => {
    expect(parseAdoConnectionString('Server=tcp:db.example.internal,14330;Initial  Catalog=app;User ID=me;Encrypt=True')).toMatchObject({
      hosts: [{ host: 'db.example.internal', port: 14330 }],
      database: 'app',
      params: { user: 'me', encrypt: 'True' },
    })
    expect(parseAdoConnectionString('Data Source=db\\SQLEXPRESS;Database=app')).toMatchObject({ hosts: [{ host: 'db' }], instanceName: 'SQLEXPRESS' })
    expect(parseAdoConnectionString('initial catalog=app')).toBeNull()
    expect(parseAdoConnectionString(42)).toBeNull()
  })
})
