/**
 * Refund policy (§6): refund only the still-unearned instructor portion.
 *
 *   remaining_unearned_i = allocated_i - earned_to_date_i - already_refunded_i
 *   refund_for_instructors <= Σ remaining_unearned_i
 *
 * Excess beyond the total unearned pool is a platform-side policy item (not taken from instructors).
 * The pool is distributed with largest-remainder, weighted by remaining_unearned_i.
 */
import { allocateLargestRemainder } from './allocator'
import { earnedToDate } from './recognition'

export interface RefundableAllocation {
  id: number
  instructorId: number
  allocatedMinor: number
  recognizedMinor: number
  refundedMinor: number
  termStartAt: Date
  termEndAt: Date
}

export interface RefundPlan {
  instructorPoolMinor: number
  platformExcessMinor: number
  lines: { allocationId: number; instructorId: number; amountMinor: number; remainingUnearnedMinor: number }[]
}

export function remainingUnearned(a: RefundableAllocation, asOf: Date): number {
  const earned = earnedToDate(a, asOf)
  // recognized may lag earned-to-date (recognition is lazy); the protective floor is max(earned, recognized).
  const protectedMinor = Math.max(earned, a.recognizedMinor)
  const remaining = a.allocatedMinor - a.refundedMinor - protectedMinor
  return remaining > 0 ? remaining : 0
}

export function planRefund(refundMinor: number, allocations: RefundableAllocation[], asOf: Date): RefundPlan {
  if (!Number.isInteger(refundMinor) || refundMinor < 0) throw new RangeError('refund amount must be a non-negative integer')

  const weights = allocations.map((a) => ({ id: a.id, weight: remainingUnearned(a, asOf), instructorId: a.instructorId }))
  const totalUnearned = weights.reduce((s, w) => s + w.weight, 0)

  const instructorPoolMinor = Math.min(refundMinor, totalUnearned)
  const platformExcessMinor = refundMinor - instructorPoolMinor

  const eligible = weights.filter((w) => w.weight > 0)
  const shares = instructorPoolMinor > 0 && eligible.length > 0
    ? allocateLargestRemainder(instructorPoolMinor, eligible.map((w) => ({ id: w.id, weight: w.weight })))
    : []
  const byId = new Map(shares.map((s) => [s.id, s.allocatedMinor]))

  return {
    instructorPoolMinor,
    platformExcessMinor,
    lines: weights.map((w) => ({
      allocationId: w.id,
      instructorId: w.instructorId,
      amountMinor: byId.get(w.id) ?? 0,
      remainingUnearnedMinor: w.weight
    }))
  }
}
