import type { SqlParam, Statement } from '../db'

export type LedgerEventName =
  | 'payment.recorded'
  | 'allocation.created'
  | 'recognition.posted'
  | 'refund.recorded'
  | 'payout.claimed'
  | 'payout.provider_called'
  | 'payout.succeeded'
  | 'payout.failed'
  | 'payout.verification_started'
  | 'payout.reconciled'
  | 'payout.reconcile_unknown'
  | 'payout.retry_noop'

export interface LedgerEvent {
  event: LedgerEventName
  payoutId?: number | null
  instructorId?: number | null
  idempotencyKey?: string | null
  providerTransactionId?: string | null
  amountMinor?: number | null
  oldStatus?: string | null
  newStatus?: string | null
  attempt?: number | null
  context?: Record<string, unknown>
}

/** Builds an INSERT statement so the audit row lands in the same atomic batch as the state change. */
export function auditStatement(e: LedgerEvent): Statement {
  const params: SqlParam[] = [
    e.event,
    e.payoutId ?? null,
    e.instructorId ?? null,
    e.idempotencyKey ?? null,
    e.providerTransactionId ?? null,
    e.amountMinor ?? null,
    e.oldStatus ?? null,
    e.newStatus ?? null,
    e.attempt ?? null,
    e.context ? JSON.stringify(e.context) : null
  ]
  return {
    sql: `INSERT INTO ledger_events (event, payout_id, instructor_id, idempotency_key, provider_transaction_id, amount_minor, old_status, new_status, attempt, context)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params
  }
}
