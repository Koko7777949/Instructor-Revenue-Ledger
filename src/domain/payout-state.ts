/**
 * Payout state machine (§7, §8). Every provider outcome maps to exactly one legal local transition.
 *
 *   PENDING ──> PROCESSING ──> SUCCEEDED   (terminal)
 *                   │  └─────> FAILED      (terminal; reservation released)
 *                   └────────> VERIFY ───> SUCCEEDED | FAILED  (via reconciliation)
 *                                 └──────> VERIFY (STATUS_UNKNOWN: keep reservation, retry later)
 */

export type PayoutStatus = 'PENDING' | 'PROCESSING' | 'VERIFY' | 'SUCCEEDED' | 'FAILED'

export const TERMINAL_STATES: ReadonlySet<PayoutStatus> = new Set(['SUCCEEDED', 'FAILED'])
export const ACTIVE_STATES: readonly PayoutStatus[] = ['PENDING', 'PROCESSING', 'VERIFY']

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL_STATES.has(status)
}

const LEGAL: Record<PayoutStatus, ReadonlySet<PayoutStatus>> = {
  PENDING: new Set(['PROCESSING']),
  PROCESSING: new Set(['SUCCEEDED', 'FAILED', 'VERIFY']),
  VERIFY: new Set(['SUCCEEDED', 'FAILED', 'VERIFY']),
  SUCCEEDED: new Set(),
  FAILED: new Set()
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return LEGAL[from].has(to)
}

export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) throw new IllegalPayoutTransition(from, to)
}

export class IllegalPayoutTransition extends Error {
  constructor(public readonly from: PayoutStatus, public readonly to: PayoutStatus) {
    super(`illegal payout transition ${from} -> ${to}`)
  }
}

/** Provider create-call outcomes as observed by the caller (§8.2). */
export type ProviderCreateOutcome =
  | { kind: 'SUCCESS'; providerTransactionId: string }
  | { kind: 'PERMANENT_FAILURE'; reason: string }
  | { kind: 'TIMEOUT' } // caller received nothing; money may or may not have moved

/** Provider status-call outcomes (§8.2). */
export type ProviderStatusOutcome =
  | { kind: 'STATUS_SUCCEEDED'; providerTransactionId: string }
  | { kind: 'STATUS_FAILED'; reason: string }
  | { kind: 'STATUS_UNKNOWN' }
  | { kind: 'STATUS_NOT_FOUND' } // provider never saw the key -> nothing moved

/** Maps a create-call outcome to the single legal next state from PROCESSING. */
export function nextStateAfterCreate(outcome: ProviderCreateOutcome): PayoutStatus {
  switch (outcome.kind) {
    case 'SUCCESS':
      return 'SUCCEEDED'
    case 'PERMANENT_FAILURE':
      return 'FAILED'
    case 'TIMEOUT':
      return 'VERIFY'
  }
}

/** Maps a status-call outcome to the single legal next state from VERIFY / stale PROCESSING. */
export function nextStateAfterStatus(outcome: ProviderStatusOutcome): PayoutStatus {
  switch (outcome.kind) {
    case 'STATUS_SUCCEEDED':
      return 'SUCCEEDED'
    case 'STATUS_FAILED':
      return 'FAILED'
    case 'STATUS_NOT_FOUND':
      // Provider has no record for the key -> the create call never landed. Nothing moved -> safe to fail & release.
      return 'FAILED'
    case 'STATUS_UNKNOWN':
      return 'VERIFY'
  }
}

/** Exponential backoff schedule for reconciliation (§13.2), capped. */
export function reconcileBackoffSeconds(attempt: number): number {
  const base = 30
  const capped = Math.min(attempt, 8)
  return Math.min(base * 2 ** capped, 6 * 3600)
}
