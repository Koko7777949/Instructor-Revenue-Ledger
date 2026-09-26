/**
 * Straight-line daily revenue recognition (§5).
 *
 *   term_days     = days_between(term_start_at, term_end_at)
 *   elapsed_days  = clamp(days_between(term_start_at, min(now, term_end_at)), 0, term_days)
 *   earned_to_date = floor(allocated_minor * elapsed_days / term_days)
 *
 * Term is a half-open interval [starts_at, ends_at) in UTC calendar days.
 * The recognizable base is the allocation net of refunded amounts, because a refund
 * removes still-unearned value from the term (§6). Earned revenue is never clawed back.
 */

const MS_PER_DAY = 86_400_000

/** Whole UTC calendar days between two instants (floor). */
export function daysBetween(start: Date, end: Date): number {
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  return Math.floor((e - s) / MS_PER_DAY)
}

export interface RecognizableAllocation {
  allocatedMinor: number
  refundedMinor: number
  termStartAt: Date
  termEndAt: Date
}

export function elapsedDays(termStartAt: Date, termEndAt: Date, asOf: Date): { termDays: number; elapsed: number } {
  const termDays = daysBetween(termStartAt, termEndAt)
  if (termDays <= 0) throw new RangeError('term must span at least one day')
  const effectiveEnd = asOf.getTime() < termEndAt.getTime() ? asOf : termEndAt
  const raw = daysBetween(termStartAt, effectiveEnd)
  const elapsed = Math.min(Math.max(raw, 0), termDays)
  return { termDays, elapsed }
}

/**
 * Earned-to-date for an allocation as of `asOf`.
 * Base = allocated - refunded (refund only ever touches unearned value, so this is monotone
 * non-decreasing across time as long as the refund cap in refund.ts is respected).
 */
export function earnedToDate(a: RecognizableAllocation, asOf: Date): number {
  const { termDays, elapsed } = elapsedDays(a.termStartAt, a.termEndAt, asOf)
  const base = a.allocatedMinor - a.refundedMinor
  if (base <= 0) return 0
  if (elapsed >= termDays) return base
  return Number((BigInt(base) * BigInt(elapsed)) / BigInt(termDays))
}

/** Delta to post: current earned minus already recognized. Never negative. */
export function recognitionDelta(a: RecognizableAllocation & { recognizedMinor: number }, asOf: Date): number {
  const delta = earnedToDate(a, asOf) - a.recognizedMinor
  return delta > 0 ? delta : 0
}

/** Adds `months` calendar months in UTC, preserving day where possible (Carbon-like). */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const daysInTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, daysInTarget))
  return d
}
