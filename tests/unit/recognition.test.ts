import { describe, expect, test } from 'vitest'
import { addMonthsUtc, daysBetween, earnedToDate, recognitionDelta } from '../../src/domain/recognition'

const start = new Date('2026-01-01T00:00:00Z')
const end = new Date('2026-02-01T00:00:00Z') // 31-day term
const alloc = { allocatedMinor: 3100, refundedMinor: 0, termStartAt: start, termEndAt: end }

describe('straight-line daily recognition', () => {
  test('before the term nothing is earned', () => {
    expect(earnedToDate(alloc, new Date('2025-12-31T23:59:59Z'))).toBe(0)
  })
  test('first day (start instant) earns 0 - half-open interval', () => {
    expect(earnedToDate(alloc, start)).toBe(0)
  })
  test('after one full day earns 1/31', () => {
    expect(earnedToDate(alloc, new Date('2026-01-02T00:00:00Z'))).toBe(100)
    // partial second day still counts only whole days
    expect(earnedToDate(alloc, new Date('2026-01-02T23:59:59Z'))).toBe(100)
  })
  test('middle of term', () => {
    expect(earnedToDate(alloc, new Date('2026-01-16T12:00:00Z'))).toBe(1500)
  })
  test('final day before end earns 30/31', () => {
    expect(earnedToDate(alloc, new Date('2026-01-31T00:00:00Z'))).toBe(3000)
  })
  test('at exact term end the full allocation is earned', () => {
    expect(earnedToDate(alloc, end)).toBe(3100)
  })
  test('after expiry stays at full allocation (clamped)', () => {
    expect(earnedToDate(alloc, new Date('2027-01-01T00:00:00Z'))).toBe(3100)
  })
  test('floor rounding on uneven amounts', () => {
    const a = { ...alloc, allocatedMinor: 1000 } // 1000 over 31 days
    expect(earnedToDate(a, new Date('2026-01-02T00:00:00Z'))).toBe(32) // floor(32.25)
    expect(earnedToDate(a, end)).toBe(1000)
  })
  test('leap-year annual term: 2028-02-01 .. 2029-02-01 = 366 days', () => {
    const s = new Date('2028-02-01T00:00:00Z')
    const e = addMonthsUtc(s, 12)
    expect(daysBetween(s, e)).toBe(366)
    const a = { allocatedMinor: 36600, refundedMinor: 0, termStartAt: s, termEndAt: e }
    expect(earnedToDate(a, new Date('2028-02-29T00:00:00Z'))).toBe(2800) // 28 days
    expect(earnedToDate(a, new Date('2028-03-01T00:00:00Z'))).toBe(2900) // leap day counted
  })
  test('refunded value reduces the recognizable base', () => {
    const a = { ...alloc, refundedMinor: 1000 } // base 2100 over 31 days
    expect(earnedToDate(a, end)).toBe(2100)
  })
  test('delta is earned minus recognized, never negative', () => {
    expect(recognitionDelta({ ...alloc, recognizedMinor: 900 }, new Date('2026-01-11T00:00:00Z'))).toBe(100)
    expect(recognitionDelta({ ...alloc, recognizedMinor: 1500 }, new Date('2026-01-11T00:00:00Z'))).toBe(0)
  })
  test('addMonthsUtc clamps end-of-month', () => {
    expect(addMonthsUtc(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
    expect(addMonthsUtc(new Date('2026-03-15T10:00:00Z'), 3).toISOString()).toBe('2026-06-15T10:00:00.000Z')
  })
  test('zero-length term rejected', () => {
    expect(() => earnedToDate({ ...alloc, termEndAt: start }, end)).toThrow(RangeError)
  })
})
