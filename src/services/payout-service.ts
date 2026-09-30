/**
 * Payout architecture (§7-§9).
 *
 *  prepare()   PrepareInstructorPayout : recognize -> read balance -> claim eligible allocations ->
 *              create payout (PENDING) + items -> reserve balance. ONE atomic batch, guarded on the
 *              balance `version` we read and on "no active payout for this instructor" (also enforced
 *              by a partial UNIQUE index). A stale worker's batch aborts -> it exits safely.
 *
 *  process()   ProcessInstructorPayout : CAS PENDING/PROCESSING -> PROCESSING, call the provider with
 *              the payout's STABLE idempotency key (never inside a DB batch), then map the outcome to
 *              exactly one transition: SUCCESS -> SUCCEEDED, PERMANENT_FAILURE -> FAILED, TIMEOUT -> VERIFY.
 *
 *  reconcile() ReconcilePayout : for VERIFY payouts (and stale PROCESSING), query provider status by key
 *              and finalize exactly once. UNKNOWN keeps the reservation and backs off.
 *
 *  Finalization is idempotent: every finalize batch is guarded on the payout still being non-terminal,
 *  so replays and concurrent workers cannot settle the same item twice.
 */
import { type Db, type Statement, guard, isGuardFailure } from '../db'
import type { PayoutProvider } from '../domain/provider'
import { nextStateAfterCreate, nextStateAfterStatus, reconcileBackoffSeconds, type PayoutStatus } from '../domain/payout-state'
import { auditStatement, type LedgerEvent } from './audit'
import { RecognitionService } from './recognition-service'
import type { Clock } from './clock'

export interface PayoutRow {
  id: number
  instructor_id: number
  amount_minor: number
  currency: string
  idempotency_key: string
  status: PayoutStatus
  provider_transaction_id: string | null
  provider_outcome: string | null
  failure_reason: string | null
  attempt_count: number
  next_check_at: string | null
  created_at: string
  processing_started_at: string | null
  completed_at: string | null
}

interface BalanceRow {
  instructor_id: number
  currency: string
  earned_minor: number
  paid_minor: number
  reserved_minor: number
  version: number
}

interface EligibleAlloc {
  id: number
  recognized_minor: number
  paid_minor: number
  reserved_minor: number
}

export interface PayoutPlan {
  instructorId: number
  currency: string
  balanceVersion: number
  amountMinor: number
  idempotencyKey: string
  items: { allocationId: number; amountMinor: number; expectPaid: number; expectReserved: number }[]
}

export type PrepareResult =
  | { created: true; payout: PayoutRow }
  | { created: false; reason: 'NOTHING_PAYABLE' | 'ACTIVE_PAYOUT_EXISTS' | 'LOST_RACE' | 'INSTRUCTOR_INACTIVE'; activePayoutId?: number }

export interface ProcessResult {
  payoutId: number
  before: PayoutStatus
  after: PayoutStatus
  providerCalled: boolean
  note: string
}

export class BalanceDriftError extends Error {
  constructor(instructorId: number, balancePayable: number, allocationPayable: number) {
    super(`balance drift for instructor ${instructorId}: snapshot payable ${balancePayable} != allocation payable ${allocationPayable}`)
    this.name = 'BalanceDriftError'
  }
}

export class PayoutService {
  private recognition: RecognitionService

  constructor(private db: Db, private provider: PayoutProvider, private clock: Clock) {
    this.recognition = new RecognitionService(db)
  }

  // ------------------------------------------------------------------ PREPARE

  /** Read phase: recognize and compute what could be paid. No reservation yet. */
  async plan(instructorId: number): Promise<PayoutPlan | PrepareResult> {
    const now = await this.clock.now()
    const instr = await this.db.first<{ status: string }>(`SELECT status FROM instructors WHERE id = ?`, [instructorId])
    if (!instr || instr.status !== 'active') return { created: false, reason: 'INSTRUCTOR_INACTIVE' }

    await this.recognition.recognizeForInstructor(instructorId, now)

    const active = await this.activePayout(instructorId)
    if (active) return { created: false, reason: 'ACTIVE_PAYOUT_EXISTS', activePayoutId: active.id }

    const balance = await this.db.first<BalanceRow>(`SELECT * FROM instructor_balances WHERE instructor_id = ?`, [instructorId])
    if (!balance) return { created: false, reason: 'NOTHING_PAYABLE' }
    const payable = balance.earned_minor - balance.paid_minor - balance.reserved_minor
    if (payable <= 0) return { created: false, reason: 'NOTHING_PAYABLE' }

    const allocs = await this.db.all<EligibleAlloc>(
      `SELECT id, recognized_minor, paid_minor, reserved_minor FROM revenue_allocations
       WHERE instructor_id = ? AND recognized_minor - paid_minor - reserved_minor > 0 ORDER BY id`,
      [instructorId]
    )
    const items = allocs.map((a) => ({
      allocationId: a.id,
      amountMinor: a.recognized_minor - a.paid_minor - a.reserved_minor,
      expectPaid: a.paid_minor,
      expectReserved: a.reserved_minor
    }))
    const allocPayable = items.reduce((s, i) => s + i.amountMinor, 0)
    if (allocPayable !== payable) throw new BalanceDriftError(instructorId, payable, allocPayable)

    return {
      instructorId,
      currency: balance.currency,
      balanceVersion: balance.version,
      amountMinor: payable,
      idempotencyKey: `payout_${instructorId}_${crypto.randomUUID()}`,
      items
    }
  }

  /** Write phase: atomically create payout + items and reserve balance, guarded on the plan's snapshot. */
  async commit(plan: PayoutPlan): Promise<PrepareResult> {
    const now = (await this.clock.now()).toISOString()
    const payoutId = await this.nextPayoutId()

    const stmts: Statement[] = [
      // Optimistic lock on the balance snapshot (stands in for SELECT ... FOR UPDATE).
      guard(`EXISTS (SELECT 1 FROM instructor_balances WHERE instructor_id = ? AND version = ?)`, [plan.instructorId, plan.balanceVersion]),
      // One instructor, one active payout (also enforced by partial unique index).
      guard(`NOT EXISTS (SELECT 1 FROM payouts WHERE instructor_id = ? AND status IN ('PENDING','PROCESSING','VERIFY'))`, [plan.instructorId]),
      {
        sql: `INSERT INTO payouts (id, instructor_id, amount_minor, currency, idempotency_key, status, attempt_count, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
        params: [payoutId, plan.instructorId, plan.amountMinor, plan.currency, plan.idempotencyKey, now, now]
      }
    ]
    for (const it of plan.items) {
      stmts.push(guard(`EXISTS (SELECT 1 FROM revenue_allocations WHERE id = ? AND paid_minor = ? AND reserved_minor = ?)`, [it.allocationId, it.expectPaid, it.expectReserved]))
      stmts.push({ sql: `INSERT INTO payout_items (payout_id, allocation_id, amount_minor, status) VALUES (?, ?, ?, 'RESERVED')`, params: [payoutId, it.allocationId, it.amountMinor] })
      stmts.push({ sql: `UPDATE revenue_allocations SET reserved_minor = reserved_minor + ? WHERE id = ?`, params: [it.amountMinor, it.allocationId] })
    }
    stmts.push({
      sql: `UPDATE instructor_balances SET reserved_minor = reserved_minor + ?, version = version + 1, updated_at = ? WHERE instructor_id = ?`,
      params: [plan.amountMinor, now, plan.instructorId]
    })
    stmts.push(auditStatement({
      event: 'payout.claimed', payoutId, instructorId: plan.instructorId, idempotencyKey: plan.idempotencyKey,
      amountMinor: plan.amountMinor, oldStatus: null, newStatus: 'PENDING', attempt: 0, context: { items: plan.items.length }
    }))

    try {
      await this.db.batch(stmts)
    } catch (err) {
      if (isGuardFailure(err) || /UNIQUE|PRIMARY KEY/i.test(String(err))) {
        const active = await this.activePayout(plan.instructorId)
        return active ? { created: false, reason: 'ACTIVE_PAYOUT_EXISTS', activePayoutId: active.id } : { created: false, reason: 'LOST_RACE' }
      }
      throw err
    }
    return { created: true, payout: (await this.getPayout(payoutId))! }
  }

  /** PrepareInstructorPayout job = plan + commit. */
  async prepare(instructorId: number): Promise<PrepareResult> {
    const plan = await this.plan(instructorId)
    if ('created' in plan) return plan
    return this.commit(plan)
  }

  // ------------------------------------------------------------------ PROCESS

  /** ProcessInstructorPayout job. Safe to run any number of times for the same payout id. */
  async process(payoutId: number): Promise<ProcessResult> {
    const payout = await this.getPayout(payoutId)
    if (!payout) throw new Error(`payout ${payoutId} not found`)
    const before = payout.status

    if (before === 'SUCCEEDED' || before === 'FAILED') {
      await this.audit({ event: 'payout.retry_noop', payoutId, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key, oldStatus: before, newStatus: before })
      return { payoutId, before, after: before, providerCalled: false, note: 'terminal state; no provider call' }
    }
    if (before === 'VERIFY') {
      // Uncertain outcome: never re-create; resolve through status lookup.
      const r = await this.reconcileOne(payout)
      return { payoutId, before, after: r.after, providerCalled: true, note: `VERIFY resolved via status lookup: ${r.note}` }
    }

    // Claim PENDING or PROCESSING. A crash before the provider call leaves PROCESSING; replay is safe
    // because the provider is idempotent on our stable key.
    const now = (await this.clock.now()).toISOString()
    const claim = await this.db.run(
      `UPDATE payouts SET status = 'PROCESSING', attempt_count = attempt_count + 1,
              processing_started_at = COALESCE(processing_started_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('PENDING','PROCESSING')`,
      [now, now, payoutId]
    )
    if (claim.changes === 0) {
      const fresh = (await this.getPayout(payoutId))!
      return { payoutId, before, after: fresh.status, providerCalled: false, note: 'lost claim; another worker moved the payout' }
    }
    const attempt = payout.attempt_count + 1
    await this.audit({ event: 'payout.provider_called', payoutId, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key, amountMinor: payout.amount_minor, oldStatus: before, newStatus: 'PROCESSING', attempt })

    const account = await this.db.first<{ provider_account_id: string }>(`SELECT provider_account_id FROM instructors WHERE id = ?`, [payout.instructor_id])
    if (!account) throw new Error('instructor missing provider account')

    // ---- Remote call: NO database batch is open here. ----
    let outcome
    try {
      outcome = await this.provider.createPayout(payout.idempotency_key, account.provider_account_id, payout.amount_minor, payout.currency)
    } catch {
      outcome = { kind: 'TIMEOUT' as const }
    }

    const target = nextStateAfterCreate(outcome)
    switch (outcome.kind) {
      case 'SUCCESS': {
        const ok = await this.finalizeSuccess(payoutId, outcome.providerTransactionId, 'CREATE', attempt)
        return { payoutId, before, after: 'SUCCEEDED', providerCalled: true, note: ok ? 'provider success; settled' : 'already finalized by another worker' }
      }
      case 'PERMANENT_FAILURE': {
        const ok = await this.finalizeFailure(payoutId, outcome.reason, 'CREATE', attempt)
        return { payoutId, before, after: 'FAILED', providerCalled: true, note: ok ? 'provider permanent failure; reservation released' : 'already finalized by another worker' }
      }
      case 'TIMEOUT': {
        await this.markVerify(payoutId, attempt)
        return { payoutId, before, after: target, providerCalled: true, note: 'provider timeout; outcome uncertain -> VERIFY (reservation kept)' }
      }
    }
  }

  // ------------------------------------------------------------------ RECONCILE

  /**
   * Sweep VERIFY payouts whose backoff has elapsed plus stale PROCESSING payouts (§13.2).
   * `force` ignores the backoff schedule - used for operator-initiated sweeps from the ops console.
   */
  async reconcileDue(opts: { limit?: number; force?: boolean } = {}): Promise<Array<{ payoutId: number; after: PayoutStatus; note: string }>> {
    const limit = opts.limit ?? 200
    const now = await this.clock.now()
    const staleRow = await this.db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'processing_stale_seconds'`)
    const staleSeconds = Number(staleRow?.value ?? 300)
    const staleBefore = new Date(now.getTime() - staleSeconds * 1000).toISOString()

    const due = await this.db.all<PayoutRow>(
      `SELECT * FROM payouts
       WHERE (status = 'VERIFY' AND (? = 1 OR next_check_at IS NULL OR next_check_at <= ?))
          OR (status = 'PROCESSING' AND processing_started_at IS NOT NULL AND processing_started_at <= ?)
       ORDER BY id LIMIT ?`,
      [opts.force ? 1 : 0, now.toISOString(), staleBefore, limit]
    )
    const out = []
    for (const p of due) out.push({ payoutId: p.id, ...(await this.reconcileOne(p)) })
    return out
  }

  async reconcileOne(payout: PayoutRow): Promise<{ after: PayoutStatus; note: string }> {
    if (payout.status === 'SUCCEEDED' || payout.status === 'FAILED') return { after: payout.status, note: 'already terminal' }
    const status = await this.provider.getPayoutStatus(payout.idempotency_key)
    const attempt = payout.attempt_count + 1
    const target = nextStateAfterStatus(status)

    switch (status.kind) {
      case 'STATUS_SUCCEEDED':
        await this.finalizeSuccess(payout.id, status.providerTransactionId, 'RECONCILE', attempt)
        return { after: 'SUCCEEDED', note: 'status lookup found SUCCESS; finalized exactly once' }
      case 'STATUS_FAILED':
        await this.finalizeFailure(payout.id, status.reason, 'RECONCILE', attempt)
        return { after: 'FAILED', note: 'status lookup found FAILED; reservation released' }
      case 'STATUS_NOT_FOUND':
        await this.finalizeFailure(payout.id, 'provider has no record for idempotency key (create never landed)', 'RECONCILE', attempt)
        return { after: 'FAILED', note: 'provider never saw the key; nothing moved; reservation released' }
      case 'STATUS_UNKNOWN': {
        const now = await this.clock.now()
        const next = new Date(now.getTime() + reconcileBackoffSeconds(attempt) * 1000).toISOString()
        await this.db.batch([
          { sql: `UPDATE payouts SET status = 'VERIFY', attempt_count = ?, next_check_at = ?, updated_at = ? WHERE id = ? AND status IN ('PROCESSING','VERIFY')`, params: [attempt, next, now.toISOString(), payout.id] },
          auditStatement({ event: 'payout.reconcile_unknown', payoutId: payout.id, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key, oldStatus: payout.status, newStatus: target, attempt, context: { nextCheckAt: next } })
        ])
        return { after: 'VERIFY', note: `provider status unknown; reservation retained; next check ${next}` }
      }
    }
  }

  // ------------------------------------------------------------------ TRANSITIONS (guarded => exactly-once)

  private async finalizeSuccess(payoutId: number, providerTxId: string, via: 'CREATE' | 'RECONCILE', attempt: number): Promise<boolean> {
    const payout = (await this.getPayout(payoutId))!
    if (payout.status === 'SUCCEEDED' || payout.status === 'FAILED') return false
    const items = await this.reservedItems(payoutId)
    const now = (await this.clock.now()).toISOString()

    const stmts: Statement[] = [
      guard(`EXISTS (SELECT 1 FROM payouts WHERE id = ? AND status IN ('PROCESSING','VERIFY'))`, [payoutId]),
      {
        sql: `UPDATE payouts SET status = 'SUCCEEDED', provider_transaction_id = ?, provider_outcome = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        params: [providerTxId, via === 'CREATE' ? 'SUCCESS' : 'STATUS_SUCCEEDED', now, now, payoutId]
      },
      { sql: `UPDATE payout_items SET status = 'PAID' WHERE payout_id = ? AND status = 'RESERVED'`, params: [payoutId] }
    ]
    for (const it of items) {
      stmts.push({ sql: `UPDATE revenue_allocations SET paid_minor = paid_minor + ?, reserved_minor = reserved_minor - ? WHERE id = ?`, params: [it.amount_minor, it.amount_minor, it.allocation_id] })
    }
    stmts.push({
      sql: `UPDATE instructor_balances SET paid_minor = paid_minor + ?, reserved_minor = reserved_minor - ?, version = version + 1, updated_at = ? WHERE instructor_id = ?`,
      params: [payout.amount_minor, payout.amount_minor, now, payout.instructor_id]
    })
    stmts.push(auditStatement({
      event: via === 'CREATE' ? 'payout.succeeded' : 'payout.reconciled', payoutId, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key,
      providerTransactionId: providerTxId, amountMinor: payout.amount_minor, oldStatus: payout.status, newStatus: 'SUCCEEDED', attempt, context: { via }
    }))

    try {
      await this.db.batch(stmts)
      return true
    } catch (err) {
      if (isGuardFailure(err) || /UNIQUE/i.test(String(err))) return false // someone else finalized first
      throw err
    }
  }

  private async finalizeFailure(payoutId: number, reason: string, via: 'CREATE' | 'RECONCILE', attempt: number): Promise<boolean> {
    const payout = (await this.getPayout(payoutId))!
    if (payout.status === 'SUCCEEDED' || payout.status === 'FAILED') return false
    const items = await this.reservedItems(payoutId)
    const now = (await this.clock.now()).toISOString()

    const stmts: Statement[] = [
      guard(`EXISTS (SELECT 1 FROM payouts WHERE id = ? AND status IN ('PROCESSING','VERIFY'))`, [payoutId]),
      {
        sql: `UPDATE payouts SET status = 'FAILED', provider_outcome = ?, failure_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        params: [via === 'CREATE' ? 'PERMANENT_FAILURE' : 'STATUS_FAILED', reason, now, now, payoutId]
      },
      { sql: `UPDATE payout_items SET status = 'RELEASED' WHERE payout_id = ? AND status = 'RESERVED'`, params: [payoutId] }
    ]
    for (const it of items) {
      stmts.push({ sql: `UPDATE revenue_allocations SET reserved_minor = reserved_minor - ? WHERE id = ?`, params: [it.amount_minor, it.allocation_id] })
    }
    stmts.push({
      sql: `UPDATE instructor_balances SET reserved_minor = reserved_minor - ?, version = version + 1, updated_at = ? WHERE instructor_id = ?`,
      params: [payout.amount_minor, now, payout.instructor_id]
    })
    stmts.push(auditStatement({
      event: 'payout.failed', payoutId, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key,
      amountMinor: payout.amount_minor, oldStatus: payout.status, newStatus: 'FAILED', attempt, context: { via, reason }
    }))

    try {
      await this.db.batch(stmts)
      return true
    } catch (err) {
      if (isGuardFailure(err)) return false
      throw err
    }
  }

  private async markVerify(payoutId: number, attempt: number): Promise<void> {
    const payout = (await this.getPayout(payoutId))!
    const now = await this.clock.now()
    const next = new Date(now.getTime() + reconcileBackoffSeconds(0) * 1000).toISOString()
    await this.db.batch([
      { sql: `UPDATE payouts SET status = 'VERIFY', provider_outcome = 'TIMEOUT', next_check_at = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'`, params: [next, now.toISOString(), payoutId] },
      auditStatement({
        event: 'payout.verification_started', payoutId, instructorId: payout.instructor_id, idempotencyKey: payout.idempotency_key,
        amountMinor: payout.amount_minor, oldStatus: 'PROCESSING', newStatus: 'VERIFY', attempt, context: { nextCheckAt: next }
      })
    ])
  }

  // ------------------------------------------------------------------ COMMAND: revenue:payouts

  /**
   * Equivalent of `php artisan revenue:payouts [--instructor=ID]`.
   * Recognizes revenue, finds instructors with positive payable balance (bounded batch), and for each
   * runs prepare -> process. Running it twice is safe: the second pass finds nothing payable / an active payout.
   */
  async runPayoutCycle(opts: { instructorId?: number; limit?: number } = {}) {
    const now = await this.clock.now()
    await this.recognition.recognizeAll(now, 5000)

    const candidates = opts.instructorId
      ? [{ instructor_id: opts.instructorId }]
      : await this.db.all<{ instructor_id: number }>(
          `SELECT b.instructor_id FROM instructor_balances b JOIN instructors i ON i.id = b.instructor_id
           WHERE i.status = 'active' AND b.earned_minor - b.paid_minor - b.reserved_minor > 0
           ORDER BY b.instructor_id LIMIT ?`,
          [opts.limit ?? 500]
        )

    const results: Array<Record<string, unknown>> = []
    for (const { instructor_id } of candidates) {
      const prep = await this.prepare(instructor_id)
      if (!prep.created) {
        results.push({ instructorId: instructor_id, prepared: false, reason: prep.reason, activePayoutId: prep.activePayoutId })
        continue
      }
      const proc = await this.process(prep.payout.id)
      results.push({ instructorId: instructor_id, prepared: true, amountMinor: prep.payout.amount_minor, ...proc })
    }
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('payouts_last_run', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [now.toISOString(), now.toISOString()]
    )
    return { asOf: now.toISOString(), candidates: candidates.length, results }
  }

  // ------------------------------------------------------------------ helpers

  async getPayout(id: number): Promise<PayoutRow | null> {
    return this.db.first<PayoutRow>(`SELECT * FROM payouts WHERE id = ?`, [id])
  }

  private activePayout(instructorId: number) {
    return this.db.first<{ id: number }>(`SELECT id FROM payouts WHERE instructor_id = ? AND status IN ('PENDING','PROCESSING','VERIFY') LIMIT 1`, [instructorId])
  }

  private reservedItems(payoutId: number) {
    return this.db.all<{ allocation_id: number; amount_minor: number }>(`SELECT allocation_id, amount_minor FROM payout_items WHERE payout_id = ? AND status = 'RESERVED'`, [payoutId])
  }

  private async audit(e: LedgerEvent) {
    const s = auditStatement(e)
    await this.db.run(s.sql, s.params)
  }

  private async nextPayoutId(): Promise<number> {
    const row = await this.db.first<{ m: number | null }>(`SELECT MAX(id) m FROM payouts`)
    return (row?.m ?? 0) + 1
  }
}
