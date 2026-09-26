/**
 * Minimal database port. Production binds Cloudflare D1; tests bind better-sqlite3.
 *
 * D1 has no interactive transactions, but `batch()` executes atomically (all-or-nothing).
 * Every money-moving transition is therefore expressed as ONE batch that includes
 * compare-and-swap guards (see `guard()`), so stale reads abort the whole batch.
 */

export type SqlParam = string | number | null

export interface Statement {
  sql: string
  params?: SqlParam[]
}

export interface RunResult {
  changes: number
  lastRowId: number
}

export interface Db {
  first<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>
  run(sql: string, params?: SqlParam[]): Promise<RunResult>
  /** Atomic: either every statement applies or none does. */
  batch(statements: Statement[]): Promise<void>
}

export class GuardFailedError extends Error {
  constructor(message = 'transaction guard failed (concurrent modification detected)') {
    super(message)
    this.name = 'GuardFailedError'
  }
}

/**
 * Build a guard statement: aborts the batch unless `conditionSql` (a boolean SQL expression) is true.
 * Implemented as an INSERT into tx_guard that violates its CHECK constraint when the condition is false.
 */
export function guard(conditionSql: string, params: SqlParam[] = []): Statement {
  return {
    sql: `INSERT INTO tx_guard (k) SELECT 'GUARD_FAILED' WHERE NOT (${conditionSql})`,
    params
  }
}

export function isGuardFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /guard_condition|CHECK constraint failed|tx_guard/i.test(msg)
}

export function nowIso(d: Date = new Date()): string {
  return d.toISOString()
}

export function sql(strings: TemplateStringsArray, ...values: SqlParam[]): Statement {
  return { sql: strings.join('?'), params: values }
}
