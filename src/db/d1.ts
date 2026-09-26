import type { Db, RunResult, SqlParam, Statement } from './index'

/** Cloudflare D1 adapter. `batch()` on D1 is transactional. */
export function d1Db(d1: D1Database): Db {
  return {
    async first<T>(sqlText: string, params: SqlParam[] = []) {
      const row = await d1.prepare(sqlText).bind(...params).first<T>()
      return (row ?? null) as T | null
    },
    async all<T>(sqlText: string, params: SqlParam[] = []) {
      const res = await d1.prepare(sqlText).bind(...params).all<T>()
      return res.results ?? []
    },
    async run(sqlText: string, params: SqlParam[] = []): Promise<RunResult> {
      const res = await d1.prepare(sqlText).bind(...params).run()
      return { changes: res.meta.changes ?? 0, lastRowId: res.meta.last_row_id ?? 0 }
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return
      await d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))))
    }
  }
}
