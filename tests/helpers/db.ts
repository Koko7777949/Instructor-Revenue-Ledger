import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sqliteDb } from '../../src/db/sqlite'
import { buildServices, type Services } from '../../src/services/container'
import { FixedClock } from '../../src/services/clock'
import { MockPayoutProvider } from '../../src/services/mock-provider'
import type { Db } from '../../src/db'

export const T0 = new Date('2026-01-01T00:00:00.000Z')

export function freshDb(): Db {
  const conn = new Database(':memory:')
  conn.pragma('foreign_keys = ON')
  conn.exec(readFileSync(resolve(__dirname, '../../migrations/0001_initial_schema.sql'), 'utf8'))
  return sqliteDb(conn)
}

export interface TestWorld extends Services {
  clock: FixedClock
  provider: MockPayoutProvider
  instructorIds: number[]
  studentId: number
  planId: (code: string) => number
}

/** Fresh in-memory DB with 3 active instructors, 1 student, and monthly/quarterly/annual plans. */
export async function world(scenario: Parameters<MockPayoutProvider['setScenario']>[0] = 'SUCCESS'): Promise<TestWorld> {
  const db = freshDb()
  const clock = new FixedClock(T0)
  const provider = new MockPayoutProvider(db, scenario)
  const s = buildServices(db, clock, provider)

  await db.batch([
    { sql: `INSERT INTO users (id, email, name, role) VALUES (1, 'a@x', 'A', 'instructor'), (2, 'b@x', 'B', 'instructor'), (3, 'c@x', 'C', 'instructor'), (9, 's@x', 'S', 'student')` },
    { sql: `INSERT INTO instructors (id, user_id, provider_account_id) VALUES (10, 1, 'acct_10'), (11, 2, 'acct_11'), (12, 3, 'acct_12')` },
    { sql: `INSERT INTO plans (id, code, name, term_months, price_minor, currency, platform_fee_bps) VALUES
        (1, 'monthly', 'M', 1, 4999, 'USD', 2000),
        (2, 'quarterly', 'Q', 3, 12995, 'USD', 2000),
        (3, 'annual', 'Y', 12, 39900, 'USD', 1500),
        (4, 'clean', 'Clean 100.00 / 20% fee', 1, 12500, 'USD', 2000)` }
  ])
  return {
    ...s,
    clock,
    provider,
    instructorIds: [10, 11, 12],
    studentId: 9,
    planId: (code) => ({ monthly: 1, quarterly: 2, annual: 3, clean: 4 })[code]!
  }
}

export async function balance(db: Db, instructorId: number) {
  const b = await db.first<{ earned_minor: number; paid_minor: number; reserved_minor: number }>(`SELECT * FROM instructor_balances WHERE instructor_id = ?`, [instructorId])
  return b ? { ...b, available: b.earned_minor - b.paid_minor - b.reserved_minor } : null
}

export async function count(db: Db, table: string, where = '1=1', params: (string | number)[] = []) {
  const r = await db.first<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`, params)
  return r?.n ?? 0
}

export function daysAfter(d: Date, days: number) {
  return new Date(d.getTime() + days * 86_400_000)
}
