/**
 * Subscription intake: turns a settled provider payment into
 *   subscription -> subscription_payment -> participant snapshot -> revenue_allocations
 * in ONE atomic batch (§4, §5.3). The participant snapshot is captured at payment time so later
 * catalog changes never rewrite the split.
 *
 * Idempotent on provider_payment_id / request_idempotency_key: replaying the same payment
 * returns the existing subscription without creating a second allocation set.
 */
import { type Db, type Statement } from '../db'
import { splitGross } from '../domain/money'
import { allocateLargestRemainder } from '../domain/allocator'
import { addMonthsUtc } from '../domain/recognition'
import { auditStatement } from './audit'

export interface RecordPaymentInput {
  userId: number
  planId: number
  providerPaymentId: string
  requestIdempotencyKey?: string
  /** Instructors attached to eligible content at payment time. Default weight 1. */
  participants: { instructorId: number; weight?: number }[]
  paidAt: Date
  startsAt?: Date
  /** Override plan price (e.g. discounts). Defaults to plan.price_minor. */
  grossMinor?: number
}

export interface RecordPaymentResult {
  subscriptionId: number
  paymentId: number
  grossMinor: number
  platformFeeMinor: number
  distributableMinor: number
  allocations: { instructorId: number; allocatedMinor: number }[]
  replayed: boolean
}

interface PlanRow {
  id: number
  term_months: number
  price_minor: number
  currency: string
  platform_fee_bps: number
  active: number
}

export class SubscriptionService {
  constructor(private db: Db) {}

  async recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
    const idem = input.requestIdempotencyKey ?? `pay:${input.providerPaymentId}`

    // Idempotent replay check.
    const existing = await this.db.first<{ id: number; subscription_id: number; gross_minor: number; platform_fee_minor: number; distributable_minor: number }>(
      `SELECT id, subscription_id, gross_minor, platform_fee_minor, distributable_minor FROM subscription_payments
       WHERE provider_payment_id = ? OR request_idempotency_key = ?`,
      [input.providerPaymentId, idem]
    )
    if (existing) {
      const allocs = await this.db.all<{ instructor_id: number; allocated_minor: number }>(
        `SELECT instructor_id, allocated_minor FROM revenue_allocations WHERE payment_id = ? ORDER BY instructor_id`,
        [existing.id]
      )
      return {
        subscriptionId: existing.subscription_id,
        paymentId: existing.id,
        grossMinor: existing.gross_minor,
        platformFeeMinor: existing.platform_fee_minor,
        distributableMinor: existing.distributable_minor,
        allocations: allocs.map((a) => ({ instructorId: a.instructor_id, allocatedMinor: a.allocated_minor })),
        replayed: true
      }
    }

    const plan = await this.db.first<PlanRow>(`SELECT * FROM plans WHERE id = ?`, [input.planId])
    if (!plan) throw new Error(`plan ${input.planId} not found`)
    if (!plan.active) throw new Error(`plan ${input.planId} is inactive`)
    if (input.participants.length === 0) throw new Error('a subscription needs at least one participating instructor')

    const ids = input.participants.map((p) => p.instructorId)
    const active = await this.db.all<{ id: number }>(
      `SELECT id FROM instructors WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    if (active.length !== new Set(ids).size) throw new Error('one or more participants are not active instructors')

    const startsAt = input.startsAt ?? input.paidAt
    const endsAt = addMonthsUtc(startsAt, plan.term_months)
    const gross = input.grossMinor ?? plan.price_minor
    const { platformFeeMinor, distributableMinor } = splitGross(gross, plan.platform_fee_bps)

    const shares = allocateLargestRemainder(
      distributableMinor,
      input.participants.map((p) => ({ id: p.instructorId, weight: p.weight ?? 1 }))
    )

    // Pre-allocate IDs so the whole graph can be inserted in one atomic batch without reading back.
    const subscriptionId = await this.nextId('subscriptions')
    const paymentId = await this.nextId('subscription_payments')

    const stmts: Statement[] = [
      {
        sql: `INSERT INTO subscriptions (id, user_id, plan_id, starts_at, ends_at, gross_minor, currency, status, provider_payment_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        params: [subscriptionId, input.userId, plan.id, startsAt.toISOString(), endsAt.toISOString(), gross, plan.currency, input.providerPaymentId]
      },
      {
        sql: `INSERT INTO subscription_payments (id, subscription_id, provider_payment_id, request_idempotency_key, gross_minor, platform_fee_bps, platform_fee_minor, distributable_minor, currency, status, paid_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?)`,
        params: [paymentId, subscriptionId, input.providerPaymentId, idem, gross, plan.platform_fee_bps, platformFeeMinor, distributableMinor, plan.currency, input.paidAt.toISOString()]
      }
    ]

    for (const p of input.participants) {
      stmts.push({
        sql: `INSERT INTO subscription_participants (subscription_id, instructor_id, weight) VALUES (?, ?, ?)`,
        params: [subscriptionId, p.instructorId, p.weight ?? 1]
      })
    }
    for (const s of shares) {
      stmts.push({
        sql: `INSERT INTO revenue_allocations (payment_id, instructor_id, currency, allocated_minor, term_start_at, term_end_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [paymentId, s.id, plan.currency, s.allocatedMinor, startsAt.toISOString(), endsAt.toISOString()]
      })
      // Ensure a balance row exists for every participating instructor (cheap read path later).
      stmts.push({
        sql: `INSERT OR IGNORE INTO instructor_balances (instructor_id, currency) VALUES (?, ?)`,
        params: [s.id, plan.currency]
      })
    }
    stmts.push(
      auditStatement({
        event: 'payment.recorded',
        amountMinor: gross,
        context: { paymentId, subscriptionId, providerPaymentId: input.providerPaymentId, platformFeeMinor, distributableMinor, participants: shares }
      })
    )

    try {
      await this.db.batch(stmts)
    } catch (err) {
      // Concurrent intake of the same or another payment can collide on the pre-allocated ids or on the
      // provider_payment_id UNIQUE. Either way the batch rolled back; re-run which will replay or re-pick ids.
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(err)) && (input as { _retry?: number })._retry !== 3) {
        return this.recordPayment({ ...input, _retry: ((input as { _retry?: number })._retry ?? 0) + 1 } as RecordPaymentInput)
      }
      throw err
    }

    return {
      subscriptionId,
      paymentId,
      grossMinor: gross,
      platformFeeMinor,
      distributableMinor,
      allocations: shares.map((s) => ({ instructorId: s.id, allocatedMinor: s.allocatedMinor })),
      replayed: false
    }
  }

  private async nextId(table: string): Promise<number> {
    // AUTOINCREMENT tables: sqlite_sequence holds the last used id (may be absent before the first insert).
    const row = await this.db.first<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = ?`, [table])
    const maxRow = await this.db.first<{ m: number | null }>(`SELECT MAX(id) m FROM ${table}`)
    return Math.max(row?.seq ?? 0, maxRow?.m ?? 0) + 1
  }
}
