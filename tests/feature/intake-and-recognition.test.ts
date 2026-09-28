import { describe, expect, test } from 'vitest'
import { world, balance, count, daysAfter, T0 } from '../helpers/db'

describe('subscription intake', () => {
  test('payment -> fee -> allocations that sum to distributable; balances rows created', async () => {
    const w = await world()
    const r = await w.subscriptions.recordPayment({
      userId: w.studentId, planId: w.planId('quarterly'), providerPaymentId: 'pi_1',
      participants: w.instructorIds.map((id) => ({ instructorId: id })), paidAt: T0
    })
    expect(r.grossMinor).toBe(12995)
    expect(r.platformFeeMinor).toBe(2599)
    expect(r.distributableMinor).toBe(10396)
    expect(r.allocations.map((a) => a.allocatedMinor)).toEqual([3466, 3465, 3465])
    const dbSum = await w.db.first<{ s: number }>(`SELECT SUM(allocated_minor) s FROM revenue_allocations WHERE payment_id = ?`, [r.paymentId])
    expect(dbSum!.s).toBe(10396)
    expect(await count(w.db, 'instructor_balances')).toBe(3)
    expect(await count(w.db, 'subscription_participants', 'subscription_id = ?', [r.subscriptionId])).toBe(3)
  })

  test('replaying the same provider payment is idempotent', async () => {
    const w = await world()
    const input = { userId: w.studentId, planId: w.planId('monthly'), providerPaymentId: 'pi_dup', participants: [{ instructorId: 10 }], paidAt: T0 }
    const a = await w.subscriptions.recordPayment(input)
    const b = await w.subscriptions.recordPayment(input)
    expect(b.replayed).toBe(true)
    expect(b.paymentId).toBe(a.paymentId)
    expect(await count(w.db, 'revenue_allocations')).toBe(1)
  })

  test('participant snapshot is immutable: later weight changes do not alter existing allocations', async () => {
    const w = await world()
    const r = await w.subscriptions.recordPayment({
      userId: w.studentId, planId: w.planId('clean'), providerPaymentId: 'pi_snap', participants: [{ instructorId: 10 }, { instructorId: 11 }], paidAt: T0
    })
    expect(r.allocations.map((a) => a.allocatedMinor)).toEqual([5000, 5000])
    // "catalog change": instructor 12 joins later; new payments include them, old one untouched
    await w.subscriptions.recordPayment({
      userId: w.studentId, planId: w.planId('clean'), providerPaymentId: 'pi_snap2', participants: [{ instructorId: 10 }, { instructorId: 11 }, { instructorId: 12 }], paidAt: T0
    })
    const old = await w.db.all<{ allocated_minor: number }>(`SELECT allocated_minor FROM revenue_allocations WHERE payment_id = ? ORDER BY instructor_id`, [r.paymentId])
    expect(old.map((x) => x.allocated_minor)).toEqual([5000, 5000])
  })

  test('rejects inactive instructor or unknown plan', async () => {
    const w = await world()
    await w.db.run(`UPDATE instructors SET status = 'suspended' WHERE id = 12`)
    await expect(w.subscriptions.recordPayment({ userId: 9, planId: 1, providerPaymentId: 'x', participants: [{ instructorId: 12 }], paidAt: T0 })).rejects.toThrow(/active/)
    await expect(w.subscriptions.recordPayment({ userId: 9, planId: 99, providerPaymentId: 'y', participants: [{ instructorId: 10 }], paidAt: T0 })).rejects.toThrow(/not found/)
  })
})

describe('revenue recognition service', () => {
  test('posts only the delta and updates the balance snapshot; re-running is a no-op', async () => {
    const w = await world()
    // clean plan: 12500 gross, 20% fee => 10000 distributable, one instructor, 1 month (31 days in Jan)
    await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId: 'p', participants: [{ instructorId: 10 }], paidAt: T0 })

    let r = await w.recognition.recognizeForInstructor(10, daysAfter(T0, 10))
    expect(r.deltaMinor).toBe(Math.floor((10000 * 10) / 31)) // 3225
    expect((await balance(w.db, 10))!.earned_minor).toBe(3225)

    r = await w.recognition.recognizeForInstructor(10, daysAfter(T0, 10))
    expect(r.deltaMinor).toBe(0)

    r = await w.recognition.recognizeForInstructor(10, daysAfter(T0, 20))
    expect(r.deltaMinor).toBe(Math.floor((10000 * 20) / 31) - 3225)

    r = await w.recognition.recognizeForInstructor(10, daysAfter(T0, 400))
    expect((await balance(w.db, 10))!.earned_minor).toBe(10000)
    const a = await w.db.first<{ recognized_minor: number }>(`SELECT recognized_minor FROM revenue_allocations WHERE instructor_id = 10`)
    expect(a!.recognized_minor).toBe(10000)
  })

  test('recognition before term start posts nothing', async () => {
    const w = await world()
    await w.subscriptions.recordPayment({ userId: 9, planId: 1, providerPaymentId: 'p', participants: [{ instructorId: 10 }], paidAt: daysAfter(T0, 5), startsAt: daysAfter(T0, 5) })
    const r = await w.recognition.recognizeForInstructor(10, T0)
    expect(r.deltaMinor).toBe(0)
  })
})
