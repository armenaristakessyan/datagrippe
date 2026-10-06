// Victim tables used by the review repro tests (created in the private test database).
import type { SessionManager } from '../../../src/main/db/session-manager'

export async function prepareVictims(manager: SessionManager, pgSession: string | null, mssqlSession: string | null): Promise<void> {
  if (pgSession) {
    await manager.execute(
      pgSession,
      `drop table if exists rv_victim; create table rv_victim(id int primary key); insert into rv_victim select generate_series(1,5);
       create or replace function rv_wipe() returns int language plpgsql as $$ begin delete from rv_victim; return 1; end $$;`,
      { maxRows: 10 },
    )
  }
  if (mssqlSession) {
    await manager.execute(
      mssqlSession,
      `if object_id('dbo.rv_victim') is not null drop table dbo.rv_victim; create table dbo.rv_victim(id int primary key); insert into dbo.rv_victim values (1),(2),(3)`,
      { maxRows: 10 },
    )
  }
}

export async function resetVictim(manager: SessionManager, sessionId: string, dialect: 'postgres' | 'mssql'): Promise<void> {
  const sql =
    dialect === 'postgres'
      ? 'delete from rv_victim; insert into rv_victim select generate_series(1,5)'
      : 'delete from dbo.rv_victim; insert into dbo.rv_victim values (1),(2),(3)'
  await manager.execute(sessionId, sql, { maxRows: 10 })
}

export async function victimCount(manager: SessionManager, sessionId: string, dialect: 'postgres' | 'mssql'): Promise<number> {
  const table = dialect === 'postgres' ? 'rv_victim' : 'dbo.rv_victim'
  const r = await manager.execute(sessionId, `select count(*) as n from ${table}`, { maxRows: 10 })
  return Number(r.results[0].rows[0][0])
}
