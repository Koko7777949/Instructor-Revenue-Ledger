/**
 * Revenue recognition (§5.2): compute earned-to-date per allocation and post ONLY the delta
 * (earned - recognized) to both the allocation and the instructor balance snapshot, atomically.
 *
 * Each allocation update is guarded on its previous recognized_minor so two concurrent runs
 * cannot double-post the same delta: the second batch's guard fails and it retries with fresh reads.
 */
import { type Db, type Statement, guard, isGuardFailure } from '../db'
import { recognitionDelta } from '../domain/recognition'
import { auditStatement } from './audit'

interface AllocRow {
  id: number
  instructor_id: number
  allocated_minor: number
  recognized_minor: number
  refunded_minor: number
  term_start_at: string
  term_end_at: string
}

export interface RecognitionSummary {
  instructorId: number
  allocationsTouched: number
  deltaMinor: number
}

export class RecognitionService {
  constructor(private db: Db) {}

  /** Recognize revenue for one instructor as of `asOf`. Returns the posted delta (0 if nothing new). */
  async recognizeForInstructor(instructorId: number, asOf: Date, attempt = 0): Promise<RecognitionSummary> {
    const rows = await this.db.all<AllocRow>(
      `SELECT id, instructor_id, allocated_minor, recognized_minor, refunded_minor, term_start_at, term_end_at
       FROM revenue_allocations
       WHERE instructor_id = ? AND recognized_minor + refunded_minor < allocated_minor
       ORDER BY id`,
      [instructorId]
    )

    const stmts: Statement[] = []
    let total = 0
    let touched = 0
    for (const r of rows) {
      const delta = recognitionDelta(
        {
          allocatedMinor: r.allocated_minor,
          refundedMinor: r.refunded_minor,
          recognizedMinor: r.recognized_minor,
          termStartAt: new Date(r.term_start_at),
          termEndAt: new Date(r.term_end_at)
        },
        asOf
      )
      if (delta <= 0) continue
      touched++
      total += delta
      // CAS: only apply if recognized_minor is still what we read.
      stmts.push(guard(`EXISTS (SELECT 1 FROM revenue_allocations WHERE id = ? AND recognized_minor = ?)`, [r.id, r.recognized_minor]))
      stmts.push({ sql: `UPDATE revenue_allocations SET recognized_minor = recognized_minor + ? WHERE id = ?`, params: [delta, r.id] })
    }
    if (total === 0) return { instructorId, allocationsTouched: 0, deltaMinor: 0 }

    stmts.push({ sql: `INSERT OR IGNORE INTO instructor_balances (instructor_id, currency) SELECT ?, currency FROM revenue_allocations WHERE instructor_id = ? LIMIT 1`, params: [instructorId, instructorId] })
    stmts.push({
      sql: `UPDATE instructor_balances SET earned_minor = earned_minor + ?, version = version + 1, updated_at = ? WHERE instructor_id = ?`,
      params: [total, asOf.toISOString(), instructorId]
    })
    stmts.push(auditStatement({ event: 'recognition.posted', instructorId, amountMinor: total, context: { asOf: asOf.toISOString(), allocations: touched } }))

    try {
      await this.db.batch(stmts)
    } catch (err) {
      if (isGuardFailure(err) && attempt < 3) return this.recognizeForInstructor(instructorId, asOf, attempt + 1)
      throw err
    }
    return { instructorId, allocationsTouched: touched, deltaMinor: total }
  }

  /** Recognize for every instructor with outstanding unrecognized allocation (bounded batch). */
  async recognizeAll(asOf: Date, limit = 1000): Promise<RecognitionSummary[]> {
    const ids = await this.db.all<{ instructor_id: number }>(
      `SELECT DISTINCT instructor_id FROM revenue_allocations
       WHERE recognized_minor + refunded_minor < allocated_minor AND term_start_at <= ?
       ORDER BY instructor_id LIMIT ?`,
      [asOf.toISOString(), limit]
    )
    const out: RecognitionSummary[] = []
    for (const { instructor_id } of ids) out.push(await this.recognizeForInstructor(instructor_id, asOf))
    return out
  }
}
