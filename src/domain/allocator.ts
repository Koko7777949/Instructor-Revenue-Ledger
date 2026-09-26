/**
 * Weighted largest-remainder allocation (§3.3 and §6.2).
 *
 * For participants i with integer weights w_i and W = Σw_i:
 *   N_i        = D * w_i
 *   base_i     = floor(N_i / W)
 *   remainder_i = N_i mod W
 * Leftover units (D - Σbase_i) are handed out one at a time to the largest remainders;
 * ties are broken by participant id ascending. Result always sums to D exactly.
 */

export interface Participant {
  id: number
  weight: number
}

export interface AllocationResult {
  id: number
  weight: number
  allocatedMinor: number
}

export function allocateLargestRemainder(distributableMinor: number, participants: Participant[]): AllocationResult[] {
  if (!Number.isInteger(distributableMinor) || distributableMinor < 0) {
    throw new RangeError(`distributable must be a non-negative integer, got ${distributableMinor}`)
  }
  if (participants.length === 0) {
    if (distributableMinor === 0) return []
    throw new Error('cannot allocate a positive amount to zero participants')
  }
  const seen = new Set<number>()
  for (const p of participants) {
    if (!Number.isInteger(p.weight) || p.weight < 0) throw new RangeError(`weight must be a non-negative integer (participant ${p.id})`)
    if (seen.has(p.id)) throw new Error(`duplicate participant id ${p.id}`)
    seen.add(p.id)
  }

  const totalWeight = participants.reduce((acc, p) => acc + BigInt(p.weight), 0n)
  if (totalWeight === 0n) {
    if (distributableMinor === 0) return participants.map((p) => ({ id: p.id, weight: p.weight, allocatedMinor: 0 }))
    throw new Error('total weight is zero but distributable amount is positive')
  }

  const D = BigInt(distributableMinor)
  const rows = participants.map((p) => {
    const numerator = D * BigInt(p.weight)
    return {
      id: p.id,
      weight: p.weight,
      base: numerator / totalWeight,
      remainder: numerator % totalWeight
    }
  })

  const baseSum = rows.reduce((acc, r) => acc + r.base, 0n)
  let leftover = Number(D - baseSum)

  // Deterministic order: largest remainder first, then id ascending.
  const order = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1
    return a.id - b.id
  })

  const extra = new Map<number, number>()
  for (const r of order) {
    if (leftover <= 0) break
    extra.set(r.id, 1)
    leftover -= 1
  }

  const result = rows.map((r) => ({
    id: r.id,
    weight: r.weight,
    allocatedMinor: Number(r.base) + (extra.get(r.id) ?? 0)
  }))

  // Invariant check: sum equals distributable exactly.
  const sum = result.reduce((acc, r) => acc + r.allocatedMinor, 0)
  if (sum !== distributableMinor) {
    throw new Error(`allocation invariant violated: sum ${sum} != distributable ${distributableMinor}`)
  }
  return result
}
