/**
 * Refunds (§6): apply a provider refund against the still-unearned instructor allocations only.
 * Earned revenue is never clawed back; any excess is a platform-side policy item.
 *
 * Race safety (§6.3): every allocation update is guarded on the exact (recognized, refunded) pair we read,
 * so a concurrent recognition or refund aborts this batch and we retry with fresh values. Because refunds
 * touch only unearned value and payouts reserve only recognized-unpaid value, the two never overlap.
 */
import { type Db, type Statement, guard, isGuardFailure } from '../db'
import { planRefund, type RefundPlan } from '../domain/refund'
import { auditStatement } from './audit'

export interface RecordRefundInput {
  paymentId: number
  providerRef: string
  refundMinor: number
  processedAt: Date
}

export interface RecordRefundResult extends RefundPlan {
  refundId: number
  replayed: boolean
}

export class RefundService {
  constructor(private db: Db) {}

  async recordRefund(input: RecordRefundInput, attempt = 0): Promise<RecordRefundResult> {
    const existing = await this.db.first<{ id: number; instructor_pool_minor: number; platform_excess_minor: number }>(
      `SELECT id, instructor_pool_minor, platform_excess_minor FROM refunds WHERE provider_ref = ?`,
      [input.providerRef]
    )
    if (existing) {
      const lines = await this.db.all<{ allocation_id: number; instructor_id: number; amount_minor: number }>(
        `SELECT ra.allocation_id, a.instructor_id, ra.amount_minor FROM refund_allocations ra JOIN revenue_allocations a ON a.id = ra.allocation_id WHERE ra.refund_id = ?`,
        [existing.id]
      )
      return {
        refundId: existing.id,
        replayed: true,
        instructorPoolMinor: existing.instructor_pool_minor,
        platformExcessMinor: existing.platform_excess_minor,
        lines: lines.map((l) => ({ allocationId: l.allocation_id, instructorId: l.instructor_id, amountMinor: l.amount_minor, remainingUnearnedMinor: 0 }))
      }
    }

    const payment = await this.db.first<{ id: number; subscription_id: number; gross_minor: number; currency: string; status: string }>(
      `SELECT id, subscription_id, gross_minor, currency, status FROM subscription_payments WHERE id = ?`,
      [input.paymentId]
    )
    if (!payment) throw new Error(`payment ${input.paymentId} not found`)
    if (input.refundMinor > payment.gross_minor) throw new Error('refund exceeds gross payment')

    const allocs = await this.db.all<{
      id: number; instructor_id: number; allocated_minor: number; recognized_minor: number; refunded_minor: number; term_start_at: string; term_end_at: string
    }>(`SELECT id, instructor_id, allocated_minor, recognized_minor, refunded_minor, term_start_at, term_end_at FROM revenue_allocations WHERE payment_id = ? ORDER BY id`, [input.paymentId])

    const plan = planRefund(
      input.refundMinor,
      allocs.map((a) => ({
        id: a.id,
        instructorId: a.instructor_id,
        allocatedMinor: a.allocated_minor,
        recognizedMinor: a.recognized_minor,
        refundedMinor: a.refunded_minor,
        termStartAt: new Date(a.term_start_at),
        termEndAt: new Date(a.term_end_at)
      })),
      input.processedAt
    )

    const refundId = await this.nextRefundId()
    const totalRefunded = await this.db.first<{ s: number }>(`SELECT COALESCE(SUM(refund_minor),0) s FROM refunds WHERE payment_id = ? AND status = 'processed'`, [input.paymentId])
    const newStatus = (totalRefunded?.s ?? 0) + input.refundMinor >= payment.gross_minor ? 'refunded' : 'partially_refunded'

    const stmts: Statement[] = [
      {
        sql: `INSERT INTO refunds (id, payment_id, provider_ref, refund_minor, instructor_pool_minor, platform_excess_minor, currency, status, processed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'processed', ?)`,
        params: [refundId, input.paymentId, input.providerRef, input.refundMinor, plan.instructorPoolMinor, plan.platformExcessMinor, payment.currency, input.processedAt.toISOString()]
      }
    ]
    for (const line of plan.lines) {
      if (line.amountMinor <= 0) continue
      const a = allocs.find((x) => x.id === line.allocationId)!
      stmts.push(guard(`EXISTS (SELECT 1 FROM revenue_allocations WHERE id = ? AND recognized_minor = ? AND refunded_minor = ?)`, [a.id, a.recognized_minor, a.refunded_minor]))
      stmts.push({ sql: `UPDATE revenue_allocations SET refunded_minor = refunded_minor + ? WHERE id = ?`, params: [line.amountMinor, a.id] })
      stmts.push({ sql: `INSERT INTO refund_allocations (refund_id, allocation_id, amount_minor) VALUES (?, ?, ?)`, params: [refundId, a.id, line.amountMinor] })
    }
    stmts.push({ sql: `UPDATE subscription_payments SET status = ? WHERE id = ?`, params: [newStatus, input.paymentId] })
    if (newStatus === 'refunded') stmts.push({ sql: `UPDATE subscriptions SET status = 'refunded' WHERE id = ?`, params: [payment.subscription_id] })
    stmts.push(
      auditStatement({
        event: 'refund.recorded',
        amountMinor: input.refundMinor,
        context: { refundId, paymentId: input.paymentId, providerRef: input.providerRef, instructorPool: plan.instructorPoolMinor, platformExcess: plan.platformExcessMinor, lines: plan.lines }
      })
    )

    try {
      await this.db.batch(stmts)
    } catch (err) {
      if ((isGuardFailure(err) || /UNIQUE|PRIMARY KEY/i.test(String(err))) && attempt < 3) return this.recordRefund(input, attempt + 1)
      throw err
    }
    return { ...plan, refundId, replayed: false }
  }

  private async nextRefundId(): Promise<number> {
    const row = await this.db.first<{ m: number | null }>(`SELECT MAX(id) m FROM refunds`)
    return (row?.m ?? 0) + 1
  }
}
