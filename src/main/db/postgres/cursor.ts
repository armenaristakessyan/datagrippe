// pg-cursor helpers. Statements always go through the extended protocol (one statement per Parse),
// which also guarantees that user text can never smuggle extra statements in.
import { EventEmitter } from 'node:events'
import type { ClientBase, FieldDef } from 'pg'
import Cursor from 'pg-cursor'
import { pgTypes } from './values'

export type RawRow = unknown[]

export interface CursorRead {
  rows: RawRow[]
  fields: FieldDef[]
}

export function openCursor(client: ClientBase, text: string, values?: unknown[]): Cursor<RawRow> {
  const cursor = new Cursor<RawRow>(text, values, { rowMode: 'array', types: pgTypes })
  return client.query(cursor)
}

/** Upper bound for the ReadyForQuery that follows a server error (the connection may be dying). */
const READY_AFTER_ERROR_MS = 5_000

/**
 * pg-cursor reports a server error as soon as the ErrorResponse arrives, before the ReadyForQuery that
 * follows its Sync: wait for that message, so the client's transaction status ('E' in a failed block, 'I'
 * after a failed implicit transaction) is current when the caller acts on the error. pg.Client registered
 * its own readyForQuery listener first, so the status is updated by the time this one runs.
 */
function afterReadyForQuery(cursor: Cursor<RawRow>, error: Error): Promise<void> {
  const connection = (cursor as unknown as { connection?: unknown }).connection
  if (!('severity' in error) || !(connection instanceof EventEmitter)) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      connection.removeListener('readyForQuery', done)
      connection.removeListener('end', done)
      resolve()
    }
    const timer = setTimeout(done, READY_AFTER_ERROR_MS)
    connection.once('readyForQuery', done)
    connection.once('end', done)
  })
}

export function readCursor(cursor: Cursor<RawRow>, count: number): Promise<CursorRead> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (error, rows, result) => {
      if (error) void afterReadyForQuery(cursor, error).then(() => reject(error))
      else resolve({ rows, fields: result?.fields ?? [] })
    })
  })
}

/** Close a cursor that is suspended or finished. Never call it after a read error (see extendedQuery). */
export async function closeCursor(cursor: Cursor<RawRow>): Promise<void> {
  await cursor.close().catch(() => undefined)
}

/** Run a statement through the extended protocol and return up to `maxRows` rows. */
export async function extendedQuery(
  client: ClientBase,
  text: string,
  values?: unknown[],
  maxRows = 1_000_000,
): Promise<CursorRead> {
  const cursor = openCursor(client, text, values)
  // On error the cursor has already sent Sync itself; closing it again would desynchronize the protocol.
  const read = await readCursor(cursor, maxRows)
  await closeCursor(cursor)
  return read
}

export interface CommandTag {
  /** e.g. "UPDATE", "CREATE TABLE", "SELECT". */
  command: string
  /** Trailing row count of the tag ("UPDATE 3" → 3, "INSERT 0 1" → 1), null when absent. */
  rowCount: number | null
}

export function parseCommandTag(tag: string): CommandTag {
  const parts = tag.trim().split(/\s+/).filter(Boolean)
  let rowCount: number | null = null
  while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1] ?? '')) {
    const n = Number.parseInt(parts.pop() ?? '', 10)
    if (rowCount === null) rowCount = n
  }
  return { command: parts.join(' ').toUpperCase(), rowCount }
}
