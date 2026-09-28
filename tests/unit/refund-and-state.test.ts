import { describe, expect, test } from 'vitest'
import { planRefund, remainingUnearned } from '../../src/domain/refund'
import { canTransition, assertTransition, nextStateAfterCreate, nextStateAfterStatus, reconcileBackoffSeconds, IllegalPayoutTransition, type PayoutStatus } from '../../src/domain/payout-state'

const start = new Date('2026-01-01T00:00:00Z')
const end = new Date('2026-01-31T00:00:00Z') // 30 days
const mk = (id: number, allocated: number, recognized = 0, refunded = 0) => ({
  id, instructorId: id, allocatedMinor: allocated, recognizedMinor: recognized, refundedMinor: refunded, termStartAt: start, termEndAt: end
})
const day10 = new Date('2026-01-11T00:00:00Z') // 10 of 30 days elapsed

describe('refund planning (unearned-only policy)', () => {
  test('remaining unearned = allocated - earned - refunded', () => {
    expect(remainingUnearned(mk(1, 3000), day10)).toBe(2000)
    // after a 500 refund the recognizable base is 2500 -> earned at day 10 = floor(2500*10/30) = 833
    // remaining = 3000 - 500 - 833 = 1667
    expect(remainingUnearned(mk(1, 3000, 0, 500), day10)).toBe(1667)
  })
  test('lazy recognition ahead of earned is still protected', () => {
    // recognized 1500 (> earned 1000) -> protected floor is 1500
    expect(remainingUnearned(mk(1, 3000, 1500), day10)).toBe(1500)
  })
  test('refund exactly the unearned amount', () => {
    const plan = planRefund(2000, [mk(1, 3000)], day10)
    expect(plan.instructorPoolMinor).toBe(2000)
    expect(plan.platformExcessMinor).toBe(0)
    expect(plan.lines[0].amountMinor).toBe(2000)
  })
  test('partial refund distributed proportionally to remaining unearned', () => {
    // unearned: A 2000, B 1000 -> weights 2:1 ; refund 900 -> 600 / 300
    const plan = planRefund(900, [mk(1, 3000), mk(2, 1500)], day10)
    expect(plan.lines.map((l) => l.amountMinor)).toEqual([600, 300])
  })
  test('refund larger than unearned cap: excess is platform-side, instructors never go negative', () => {
    const plan = planRefund(5000, [mk(1, 3000), mk(2, 1500)], day10)
    expect(plan.instructorPoolMinor).toBe(3000)
    expect(plan.platformExcessMinor).toBe(2000)
    expect(plan.lines.map((l) => l.amountMinor)).toEqual([2000, 1000])
  })
  test('fully earned allocation receives no refund share', () => {
    const plan = planRefund(100, [mk(1, 3000)], new Date('2026-03-01T00:00:00Z'))
    expect(plan.instructorPoolMinor).toBe(0)
    expect(plan.platformExcessMinor).toBe(100)
  })
  test('odd cents in refund split still sum exactly', () => {
    const plan = planRefund(1001, [mk(1, 3000), mk(2, 3000), mk(3, 3000)], day10)
    expect(plan.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(1001)
  })
})

describe('payout state machine', () => {
  const all: PayoutStatus[] = ['PENDING', 'PROCESSING', 'VERIFY', 'SUCCEEDED', 'FAILED']
  test('terminal states have no exits', () => {
    for (const to of all) {
      expect(canTransition('SUCCEEDED', to)).toBe(false)
      expect(canTransition('FAILED', to)).toBe(false)
    }
  })
  test('PENDING can only go to PROCESSING', () => {
    expect(all.filter((to) => canTransition('PENDING', to))).toEqual(['PROCESSING'])
  })
  test('PROCESSING -> SUCCEEDED | FAILED | VERIFY', () => {
    expect(all.filter((to) => canTransition('PROCESSING', to)).sort()).toEqual(['FAILED', 'SUCCEEDED', 'VERIFY'])
  })
  test('VERIFY may stay VERIFY (unknown) or resolve', () => {
    expect(all.filter((to) => canTransition('VERIFY', to)).sort()).toEqual(['FAILED', 'SUCCEEDED', 'VERIFY'])
  })
  test('assertTransition throws typed error', () => {
    expect(() => assertTransition('SUCCEEDED', 'FAILED')).toThrow(IllegalPayoutTransition)
  })
  test('each provider outcome maps to exactly one state', () => {
    expect(nextStateAfterCreate({ kind: 'SUCCESS', providerTransactionId: 'x' })).toBe('SUCCEEDED')
    expect(nextStateAfterCreate({ kind: 'PERMANENT_FAILURE', reason: 'r' })).toBe('FAILED')
    expect(nextStateAfterCreate({ kind: 'TIMEOUT' })).toBe('VERIFY')
    expect(nextStateAfterStatus({ kind: 'STATUS_SUCCEEDED', providerTransactionId: 'x' })).toBe('SUCCEEDED')
    expect(nextStateAfterStatus({ kind: 'STATUS_FAILED', reason: 'r' })).toBe('FAILED')
    expect(nextStateAfterStatus({ kind: 'STATUS_UNKNOWN' })).toBe('VERIFY')
    expect(nextStateAfterStatus({ kind: 'STATUS_NOT_FOUND' })).toBe('FAILED')
  })
  test('reconcile backoff is exponential and capped', () => {
    expect(reconcileBackoffSeconds(0)).toBe(30)
    expect(reconcileBackoffSeconds(1)).toBe(60)
    expect(reconcileBackoffSeconds(3)).toBe(240)
    expect(reconcileBackoffSeconds(50)).toBe(6 * 3600)
  })
})
