/**
 * Monetary model (§3). All amounts are integer minor units (cents).
 * BigInt is used for intermediate products so 500k-subscription-scale sums never overflow.
 */

export const BPS_DENOMINATOR = 10_000

export function assertMinor(value: number, label = 'amount'): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a non-negative safe integer in minor units, got ${value}`)
  }
}

export function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new RangeError(`fee basis points must be in 0..${BPS_DENOMINATOR}, got ${bps}`)
  }
}

/** round_half_up(G * F / 10_000) using integer arithmetic only. */
export function platformFee(grossMinor: number, feeBps: number): number {
  assertMinor(grossMinor, 'grossMinor')
  assertBps(feeBps)
  const numerator = BigInt(grossMinor) * BigInt(feeBps)
  const denom = BigInt(BPS_DENOMINATOR)
  // half-up: floor((2n + d) / 2d)
  const fee = (numerator * 2n + denom) / (denom * 2n)
  return Number(fee)
}

export interface FeeSplit {
  grossMinor: number
  platformFeeMinor: number
  distributableMinor: number
}

export function splitGross(grossMinor: number, feeBps: number): FeeSplit {
  const platformFeeMinor = platformFee(grossMinor, feeBps)
  return { grossMinor, platformFeeMinor, distributableMinor: grossMinor - platformFeeMinor }
}

/** Format minor units for display: 12995 -> "129.95". Never used for arithmetic. */
export function formatMinor(minor: number, currency = 'USD'): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const major = Math.floor(abs / 100)
  const cents = String(abs % 100).padStart(2, '0')
  return `${sign}${currency} ${major.toLocaleString('en-US')}.${cents}`
}
