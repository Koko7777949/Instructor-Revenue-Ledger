import { describe, expect, test } from 'vitest'
import { platformFee, splitGross, formatMinor } from '../../src/domain/money'

describe('platform fee (integer basis points, round half up)', () => {
  test('zero gross -> zero fee', () => expect(platformFee(0, 2000)).toBe(0))
  test('zero bps -> zero fee', () => expect(platformFee(12995, 0)).toBe(0))
  test('100% fee takes everything', () => expect(platformFee(12995, 10000)).toBe(12995))
  test('20% of 129.95 = 25.99', () => expect(platformFee(12995, 2000)).toBe(2599))
  test('half-up rounding: 15% of 3 cents = 0.45 -> 0', () => expect(platformFee(3, 1500)).toBe(0))
  test('half-up rounding: 25% of 2 cents = 0.5 -> 1', () => expect(platformFee(2, 2500)).toBe(1))
  test('odd cents 33.33% of 1', () => expect(platformFee(1, 3333)).toBe(0))
  test('large values do not lose precision', () => expect(platformFee(9_007_199_254, 1234)).toBe(1_111_488_388))
  test('boundary bps rejected', () => {
    expect(() => platformFee(100, 10001)).toThrow(RangeError)
    expect(() => platformFee(100, -1)).toThrow(RangeError)
  })
  test('non-integer minor rejected', () => expect(() => platformFee(129.95, 2000)).toThrow(RangeError))
  test('gross = fee + distributable always', () => {
    for (const g of [0, 1, 2, 99, 12995, 39900, 123456789]) {
      for (const bps of [0, 1, 1500, 2000, 3333, 9999, 10000]) {
        const s = splitGross(g, bps)
        expect(s.platformFeeMinor + s.distributableMinor).toBe(g)
      }
    }
  })
})

describe('formatMinor', () => {
  test('formats cents for display only', () => {
    expect(formatMinor(12995)).toBe('USD 129.95')
    expect(formatMinor(5)).toBe('USD 0.05')
    expect(formatMinor(100000000, 'EUR')).toBe('EUR 1,000,000.00')
  })
})
