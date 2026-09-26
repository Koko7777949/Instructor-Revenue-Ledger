/**
 * better-sqlite3 adapter for the test suite (Node only; never bundled into the Worker).
 * Mirrors D1 semantics: batch() runs inside one SQLite transaction and rolls back on any error.
 */
import type Database from 'better-sqlite3'
import type { Db, RunResult, SqlParam, Statement } from './index'

export function sqliteDb(conn: Database.Database): Db {
  return {
    async first<T>(sqlText: string, params: SqlParam[] = []) {
      const row = conn.prepare(sqlText).get(...params) as T | undefined
      return row ?? null
    },
    async all<T>(sqlText: string, params: SqlParam[] = []) {
      return conn.prepare(sqlText).all(...params) as T[]
    },
    async run(sqlText: string, params: SqlParam[] = []): Promise<RunResult> {
      const info = conn.prepare(sqlText).run(...params)
      return { changes: info.changes, lastRowId: Number(info.lastInsertRowid) }
    },
    async batch(statements: Statement[]) {
      const tx = conn.transaction((stmts: Statement[]) => {
        for (const s of stmts) conn.prepare(s.sql).run(...(s.params ?? []))
      })
      tx(statements)
    }
  }
}
