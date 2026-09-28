import { describe, expect, test } from 'vitest'
import { allocateLargestRemainder } from '../../src/domain/allocator'

const sum = (r: { allocatedMinor: number }[]) => r.reduce((s, x) => s + x.allocatedMinor, 0)

describe('weighted largest-remainder allocation', () => {
  test('doc example: 10000 across 3 equal -> 3334/3333/3333 with leftover to lowest id', () => {
    const r = allocateLargestRemainder(10000, [{ id: 10, weight: 1 }, { id: 11, weight: 1 }, { id: 12, weight: 1 }])
    expect(r.map((x) => x.allocatedMinor)).toEqual([3334, 3333, 3333])
    expect(sum(r)).toBe(10000)
  })

  test('2-way / 3-way / 5-way equal splits always sum exactly', () => {
    for (const n of [2, 3, 5]) {
      for (const D of [0, 1, 7, 99, 10000, 10001, 12995, 999_999_999]) {
        const r = allocateLargestRemainder(D, Array.from({ length: n }, (_, i) => ({ id: i + 1, weight: 1 })))
        expect(sum(r)).toBe(D)
        const vals = r.map((x) => x.allocatedMinor)
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1)
      }
    }
  })

  test('weighted split 2:1 of 10000 -> 6667 / 3333', () => {
    const r = allocateLargestRemainder(10000, [{ id: 1, weight: 2 }, { id: 2, weight: 1 }])
    expect(r.map((x) => x.allocatedMinor)).toEqual([6667, 3333])
  })

  test('deterministic tie-break by id ascending regardless of input order', () => {
    const a = allocateLargestRemainder(100, [{ id: 3, weight: 1 }, { id: 1, weight: 1 }, { id: 2, weight: 1 }])
    const byId = Object.fromEntries(a.map((x) => [x.id, x.allocatedMinor]))
    expect(byId).toEqual({ 1: 34, 2: 33, 3: 33 })
  })

  test('largest remainder wins over id order', () => {
    // D=10, weights 1,2,7 -> N: 10,20,70 ; base: 1,2,7 (exact) no leftover
    expect(allocateLargestRemainder(10, [{ id: 1, weight: 1 }, { id: 2, weight: 2 }, { id: 3, weight: 7 }]).map((x) => x.allocatedMinor)).toEqual([1, 2, 7])
    // D=10, weights 1,1,3 (W=5): N: 10,10,30 -> base 2,2,6 exact
    // D=11, weights 1,1,3: N: 11,11,33 -> base 2,2,6 rem 1,1,3 -> leftover 1 goes to id 3 (largest rem)
    expect(allocateLargestRemainder(11, [{ id: 1, weight: 1 }, { id: 2, weight: 1 }, { id: 3, weight: 3 }]).map((x) => x.allocatedMinor)).toEqual([2, 2, 7])
  })

  test('zero-weight participants receive nothing', () => {
    const r = allocateLargestRemainder(100, [{ id: 1, weight: 0 }, { id: 2, weight: 1 }])
    expect(r.map((x) => x.allocatedMinor)).toEqual([0, 100])
  })

  test('zero distributable yields zeros', () => {
    expect(allocateLargestRemainder(0, [{ id: 1, weight: 1 }, { id: 2, weight: 1 }]).map((x) => x.allocatedMinor)).toEqual([0, 0])
  })

  test('rejects invalid input', () => {
    expect(() => allocateLargestRemainder(100, [])).toThrow()
    expect(() => allocateLargestRemainder(-1, [{ id: 1, weight: 1 }])).toThrow(RangeError)
    expect(() => allocateLargestRemainder(100, [{ id: 1, weight: 1 }, { id: 1, weight: 1 }])).toThrow(/duplicate/)
    expect(() => allocateLargestRemainder(100, [{ id: 1, weight: 0 }])).toThrow(/total weight/)
  })

  test('property: random weights always sum to D and never exceed proportional share by more than 1', () => {
    let seed = 42
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 12)
      const parts = Array.from({ length: n }, (_, i) => ({ id: i + 1, weight: 1 + Math.floor(rnd() * 9) }))
      const D = Math.floor(rnd() * 1_000_000)
      const r = allocateLargestRemainder(D, parts)
      expect(sum(r)).toBe(D)
      const W = parts.reduce((s, p) => s + p.weight, 0)
      for (const x of r) {
        const exact = (D * x.weight) / W
        expect(x.allocatedMinor).toBeGreaterThanOrEqual(Math.floor(exact))
        expect(x.allocatedMinor).toBeLessThanOrEqual(Math.floor(exact) + 1)
      }
    }
  })
})
