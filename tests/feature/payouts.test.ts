/**
 * §10.2 Required behavioral tests + §10.4 concurrency test.
 * Setup: "clean" plan = 12500 gross, 20% fee => 10000 distributable over a 31-day January term.
 */
import { describe, expect, test } from 'vitest'
import { world, balance, count, daysAfter, T0, type TestWorld } from '../helpers/db'

async function fund(w: TestWorld, instructorId = 10, providerPaymentId = 'pi_fund') {
  await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId, participants: [{ instructorId }], paidAt: T0 })
  w.clock.set(daysAfter(T0, 31)) // full term elapsed -> 10000 payable
}

describe('1. running the payout command twice', () => {
  test('creates exactly one payout and one provider transaction per instructor', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const first = await w.payouts.runPayoutCycle()
    const second = await w.payouts.runPayoutCycle()

    expect(first.results).toHaveLength(1)
    expect(first.results[0]).toMatchObject({ prepared: true, after: 'SUCCEEDED', amountMinor: 10000 })
    expect(second.candidates).toBe(0) // nothing payable anymore

    expect(await count(w.db, 'payouts')).toBe(1)
    expect(await count(w.db, 'mock_provider_transactions')).toBe(1)
    expect(await balance(w.db, 10)).toMatchObject({ earned_minor: 10000, paid_minor: 10000, reserved_minor: 0, available: 0 })
    const a = await w.db.first<{ paid_minor: number; reserved_minor: number }>(`SELECT paid_minor, reserved_minor FROM revenue_allocations WHERE instructor_id = 10`)
    expect(a).toEqual({ paid_minor: 10000, reserved_minor: 0 })
  })

  test('mid-term run pays only the earned portion; later run pays the rest', async () => {
    const w = await world('SUCCESS')
    await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId: 'p', participants: [{ instructorId: 10 }], paidAt: T0 })
    w.clock.set(daysAfter(T0, 10))
    const r1 = await w.payouts.runPayoutCycle()
    expect(r1.results[0]).toMatchObject({ amountMinor: 3225, after: 'SUCCEEDED' })
    w.clock.set(daysAfter(T0, 31))
    const r2 = await w.payouts.runPayoutCycle()
    expect(r2.results[0]).toMatchObject({ amountMinor: 6775, after: 'SUCCEEDED' })
    expect((await balance(w.db, 10))!.paid_minor).toBe(10000)
    expect(await count(w.db, 'payouts')).toBe(2)
  })
})

describe('2. running the same payout job twice', () => {
  test('second process() is a no-op: one settled payout, one set of paid amounts, no provider call', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const prep = await w.payouts.prepare(10)
    expect(prep.created).toBe(true)
    const id = (prep as { payout: { id: number } }).payout.id

    const a = await w.payouts.process(id)
    const callsAfterFirst = w.provider.createCalls
    const b = await w.payouts.process(id)

    expect(a.after).toBe('SUCCEEDED')
    expect(b).toMatchObject({ before: 'SUCCEEDED', after: 'SUCCEEDED', providerCalled: false })
    expect(w.provider.createCalls).toBe(callsAfterFirst)
    expect((await balance(w.db, 10))!.paid_minor).toBe(10000)
    expect(await count(w.db, 'ledger_events', `event = 'payout.retry_noop'`)).toBe(1)
  })

  test('prepare() twice yields one payout (second sees active payout)', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const a = await w.payouts.prepare(10)
    const b = await w.payouts.prepare(10)
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ created: false, reason: 'ACTIVE_PAYOUT_EXISTS' })
    expect(await count(w.db, 'payouts')).toBe(1)
    expect((await balance(w.db, 10))!.reserved_minor).toBe(10000)
  })
})

describe('3. TIMEOUT_AFTER_SUCCESS', () => {
  test('payout goes to VERIFY, reservation is kept, retry does NOT create a second provider transaction', async () => {
    const w = await world('TIMEOUT_AFTER_SUCCESS')
    await fund(w)
    const run = await w.payouts.runPayoutCycle()
    expect(run.results[0]).toMatchObject({ after: 'VERIFY' })
    const payout = (await w.payouts.getPayout(1))!
    expect(payout.status).toBe('VERIFY')
    expect(await balance(w.db, 10)).toMatchObject({ reserved_minor: 10000, paid_minor: 0, available: 0 })
    expect(await w.provider.transactionsForKey(payout.idempotency_key)).toBe(1) // money DID move

    // Retry the job -> resolves via status lookup, same key, same payout.
    const retry = await w.payouts.process(1)
    expect(retry.after).toBe('SUCCEEDED')
    expect(await count(w.db, 'payouts')).toBe(1)
    expect(await count(w.db, 'mock_provider_transactions')).toBe(1)
    expect(await w.provider.transactionsForKey(payout.idempotency_key)).toBe(1)
    expect(await balance(w.db, 10)).toMatchObject({ reserved_minor: 0, paid_minor: 10000 })
    const final = (await w.payouts.getPayout(1))!
    expect(final.provider_transaction_id).toBeTruthy()
    expect(final.provider_outcome).toBe('STATUS_SUCCEEDED')

    // A subsequent command run must not try to pay again.
    const again = await w.payouts.runPayoutCycle()
    expect(again.candidates).toBe(0)
  })

  test('reconciliation (not retry) also finalizes exactly once', async () => {
    const w = await world('TIMEOUT_AFTER_SUCCESS')
    await fund(w)
    await w.payouts.runPayoutCycle()
    w.clock.set(daysAfter(T0, 32)) // past next_check_at
    const rec = await w.payouts.reconcileDue()
    expect(rec).toHaveLength(1)
    expect(rec[0].after).toBe('SUCCEEDED')
    expect(await count(w.db, 'ledger_events', `event = 'payout.reconciled'`)).toBe(1)
    // second reconcile pass: nothing due
    expect(await w.payouts.reconcileDue()).toHaveLength(0)
    expect((await balance(w.db, 10))!.paid_minor).toBe(10000)
  })
})

describe('4. worker crash after provider success, before local finalization', () => {
  test('replay finds the provider record by key and repairs local state', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const prep = await w.payouts.prepare(10)
    const payout = (prep as { payout: { id: number; idempotency_key: string } }).payout

    // Simulate: worker claimed PROCESSING and the provider succeeded, then the worker died.
    await w.db.run(`UPDATE payouts SET status = 'PROCESSING', attempt_count = 1, processing_started_at = ? WHERE id = ?`, [T0.toISOString(), payout.id])
    await w.provider.createPayout(payout.idempotency_key, 'acct_10', 10000, 'USD')
    expect(await balance(w.db, 10)).toMatchObject({ reserved_minor: 10000, paid_minor: 0 })

    // Path A: job replay -> provider returns the stored SUCCESS for the same key.
    const r = await w.payouts.process(payout.id)
    expect(r.after).toBe('SUCCEEDED')
    expect(await count(w.db, 'mock_provider_transactions')).toBe(1)
    expect(await balance(w.db, 10)).toMatchObject({ reserved_minor: 0, paid_minor: 10000 })
  })

  test('stale PROCESSING payout is picked up by reconciliation', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const prep = await w.payouts.prepare(10)
    const payout = (prep as { payout: { id: number; idempotency_key: string } }).payout
    await w.db.run(`UPDATE payouts SET status = 'PROCESSING', attempt_count = 1, processing_started_at = ? WHERE id = ?`, [T0.toISOString(), payout.id])
    await w.provider.createPayout(payout.idempotency_key, 'acct_10', 10000, 'USD')

    const rec = await w.payouts.reconcileDue() // clock is 31 days later -> definitely stale
    expect(rec[0]).toMatchObject({ payoutId: payout.id, after: 'SUCCEEDED' })
    expect((await balance(w.db, 10))!.paid_minor).toBe(10000)
  })

  test('crash BEFORE provider call (PROCESSING, provider never saw key): replay pays exactly once', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    const prep = await w.payouts.prepare(10)
    const id = (prep as { payout: { id: number } }).payout.id
    await w.db.run(`UPDATE payouts SET status = 'PROCESSING', attempt_count = 1, processing_started_at = ? WHERE id = ?`, [T0.toISOString(), id])
    const r = await w.payouts.process(id)
    expect(r.after).toBe('SUCCEEDED')
    expect(await count(w.db, 'mock_provider_transactions')).toBe(1)
  })
})

describe('5. two concurrent payout jobs for the same instructor', () => {
  test('both read the same balance; only one commit wins; one payout, one provider transaction', async () => {
    const w = await world('SUCCESS')
    await fund(w)

    // Both workers plan against the identical snapshot (simulates two workers reading before either writes).
    const planA = await w.payouts.plan(10)
    const planB = await w.payouts.plan(10)
    expect('created' in planA).toBe(false)
    expect('created' in planB).toBe(false)

    const [a, b] = await Promise.all([w.payouts.commit(planA as never), w.payouts.commit(planB as never)])
    const winners = [a, b].filter((r) => r.created)
    const losers = [a, b].filter((r) => !r.created)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(['ACTIVE_PAYOUT_EXISTS', 'LOST_RACE']).toContain((losers[0] as { reason: string }).reason)

    expect(await count(w.db, 'payouts')).toBe(1)
    expect(await balance(w.db, 10)).toMatchObject({ reserved_minor: 10000, available: 0 })

    // Both workers now try to process the single payout concurrently.
    const id = (winners[0] as { payout: { id: number } }).payout.id
    await Promise.all([w.payouts.process(id), w.payouts.process(id)])
    expect(await count(w.db, 'mock_provider_transactions')).toBe(1)
    expect(await balance(w.db, 10)).toMatchObject({ paid_minor: 10000, reserved_minor: 0 })
    const item = await w.db.first<{ n: number }>(`SELECT COUNT(*) n FROM payout_items WHERE status = 'PAID'`)
    expect(item!.n).toBe(1)
  })

  test('DB-level guard: a second active payout row for the same instructor is impossible', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    await w.payouts.prepare(10)
    await expect(
      w.db.run(`INSERT INTO payouts (instructor_id, amount_minor, currency, idempotency_key, status) VALUES (10, 1, 'USD', 'k2', 'PENDING')`)
    ).rejects.toThrow(/UNIQUE/)
  })

  test('balance invariant: allocations paid+reserved can never exceed recognized (CHECK constraint)', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    await w.recognition.recognizeForInstructor(10, daysAfter(T0, 31))
    await expect(w.db.run(`UPDATE revenue_allocations SET reserved_minor = 10001 WHERE instructor_id = 10`)).rejects.toThrow(/CHECK/)
    await expect(w.db.run(`UPDATE instructor_balances SET paid_minor = 10001 WHERE instructor_id = 10`)).rejects.toThrow(/CHECK/)
  })
})

describe('6. permanent provider failure', () => {
  test('payout FAILED, reservation released, earnings payable again with a NEW payout id', async () => {
    const w = await world('PERMANENT_FAILURE')
    await fund(w)
    const r1 = await w.payouts.runPayoutCycle()
    expect(r1.results[0]).toMatchObject({ after: 'FAILED' })
    expect(await balance(w.db, 10)).toMatchObject({ earned_minor: 10000, paid_minor: 0, reserved_minor: 0, available: 10000 })
    const items = await w.db.all<{ status: string }>(`SELECT status FROM payout_items`)
    expect(items.map((i) => i.status)).toEqual(['RELEASED'])
    const alloc = await w.db.first<{ reserved_minor: number; paid_minor: number }>(`SELECT reserved_minor, paid_minor FROM revenue_allocations WHERE instructor_id = 10`)
    expect(alloc).toEqual({ reserved_minor: 0, paid_minor: 0 })

    // Provider recovers; next cycle creates a fresh payout intent (new key), referencing the same allocation.
    w.provider.setScenario('SUCCESS')
    const r2 = await w.payouts.runPayoutCycle()
    expect(r2.results[0]).toMatchObject({ after: 'SUCCEEDED', amountMinor: 10000 })
    const payouts = await w.db.all<{ id: number; status: string; idempotency_key: string }>(`SELECT id, status, idempotency_key FROM payouts ORDER BY id`)
    expect(payouts.map((p) => p.status)).toEqual(['FAILED', 'SUCCEEDED'])
    expect(payouts[0].idempotency_key).not.toBe(payouts[1].idempotency_key)
    expect(await count(w.db, 'payout_items', 'allocation_id = 1')).toBe(2)
  })

  test('TIMEOUT with no provider effect -> VERIFY -> reconcile finds NOT_FOUND -> FAILED and released', async () => {
    const w = await world('TIMEOUT_NO_EFFECT')
    await fund(w)
    await w.payouts.runPayoutCycle()
    expect((await w.payouts.getPayout(1))!.status).toBe('VERIFY')
    w.clock.set(daysAfter(T0, 32))
    const rec = await w.payouts.reconcileDue()
    expect(rec[0].after).toBe('FAILED')
    expect((await balance(w.db, 10))!.available).toBe(10000)
  })

  test('STATUS_UNKNOWN keeps reservation and backs off; resolves once provider settles', async () => {
    const w = await world('STATUS_UNKNOWN')
    await fund(w)
    await w.payouts.runPayoutCycle()
    w.clock.set(daysAfter(T0, 32))
    let rec = await w.payouts.reconcileDue()
    expect(rec[0].after).toBe('VERIFY')
    expect((await balance(w.db, 10))!.reserved_minor).toBe(10000)
    const p = (await w.payouts.getPayout(1))!
    expect(p.next_check_at! > w.clock['at'].toISOString()).toBe(true)
    // not due yet
    expect(await w.payouts.reconcileDue()).toHaveLength(0)
    // provider settles
    w.provider.setScenario('SUCCESS')
    w.clock.set(daysAfter(T0, 40))
    rec = await w.payouts.reconcileDue()
    expect(rec[0].after).toBe('SUCCEEDED')
    expect((await balance(w.db, 10))!.paid_minor).toBe(10000)
  })
})

describe('7. refund before recognition', () => {
  test('reduces future earnings but does not claw back recognized revenue', async () => {
    const w = await world('SUCCESS')
    // clean plan, 10000 distributable, instructor 10 only, 31-day term
    const pay = await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId: 'p', participants: [{ instructorId: 10 }], paidAt: T0 })

    // Day 10: recognize -> 3225 earned; pay it out.
    w.clock.set(daysAfter(T0, 10))
    await w.payouts.runPayoutCycle()
    expect(await balance(w.db, 10)).toMatchObject({ earned_minor: 3225, paid_minor: 3225 })

    // Day 10: customer refunds 5000. Unearned = 10000 - 3225 = 6775 -> whole refund hits instructor pool.
    const refund = await w.refunds.recordRefund({ paymentId: pay.paymentId, providerRef: 're_1', refundMinor: 5000, processedAt: daysAfter(T0, 10) })
    expect(refund.instructorPoolMinor).toBe(5000)
    expect(refund.platformExcessMinor).toBe(0)
    const alloc = await w.db.first<{ allocated_minor: number; refunded_minor: number; recognized_minor: number }>(`SELECT allocated_minor, refunded_minor, recognized_minor FROM revenue_allocations WHERE id = 1`)
    expect(alloc).toEqual({ allocated_minor: 10000, refunded_minor: 5000, recognized_minor: 3225 })

    // Earned revenue is untouched (no clawback); balance never goes negative.
    expect((await balance(w.db, 10))!.earned_minor).toBe(3225)
    expect((await balance(w.db, 10))!.available).toBe(0)

    // End of term: total recognizable is now allocated - refunded = 5000.
    w.clock.set(daysAfter(w.clock['at'], 30))
    const r = await w.payouts.runPayoutCycle()
    expect(r.results[0]).toMatchObject({ amountMinor: 5000 - 3225, after: 'SUCCEEDED' })
    expect(await balance(w.db, 10)).toMatchObject({ earned_minor: 5000, paid_minor: 5000, available: 0 })
    const pmt = await w.db.first<{ status: string }>(`SELECT status FROM subscription_payments WHERE id = ?`, [pay.paymentId])
    expect(pmt!.status).toBe('partially_refunded')
  })

  test('refund larger than unearned: instructors capped, excess recorded platform-side', async () => {
    const w = await world('SUCCESS')
    const pay = await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId: 'p', participants: [{ instructorId: 10 }, { instructorId: 11 }], paidAt: T0 })
    w.clock.set(daysAfter(T0, 31)) // fully earned
    await w.recognition.recognizeForInstructor(10, daysAfter(T0, 31))
    await w.recognition.recognizeForInstructor(11, daysAfter(T0, 31))
    const refund = await w.refunds.recordRefund({ paymentId: pay.paymentId, providerRef: 're_x', refundMinor: 12500, processedAt: daysAfter(T0, 31) })
    expect(refund.instructorPoolMinor).toBe(0)
    expect(refund.platformExcessMinor).toBe(12500)
    expect((await balance(w.db, 10))!.earned_minor).toBe(5000)
    const pmt = await w.db.first<{ status: string }>(`SELECT status FROM subscription_payments WHERE id = ?`, [pay.paymentId])
    expect(pmt!.status).toBe('refunded')
  })

  test('refund is proportional across instructors and idempotent on provider_ref', async () => {
    const w = await world('SUCCESS')
    const pay = await w.subscriptions.recordPayment({ userId: 9, planId: w.planId('clean'), providerPaymentId: 'p', participants: [{ instructorId: 10, weight: 3 }, { instructorId: 11, weight: 1 }], paidAt: T0 })
    // allocations 7500 / 2500; at day 0 nothing earned -> refund 1000 splits 750 / 250
    const a = await w.refunds.recordRefund({ paymentId: pay.paymentId, providerRef: 're_p', refundMinor: 1000, processedAt: T0 })
    expect(a.lines.map((l) => l.amountMinor)).toEqual([750, 250])
    const b = await w.refunds.recordRefund({ paymentId: pay.paymentId, providerRef: 're_p', refundMinor: 1000, processedAt: T0 })
    expect(b.replayed).toBe(true)
    expect(await count(w.db, 'refunds')).toBe(1)
    expect(await count(w.db, 'refund_allocations')).toBe(2)
  })
})

describe('audit trail', () => {
  test('a completed payout can be explained: payout -> items -> allocation -> payment', async () => {
    const w = await world('SUCCESS')
    await fund(w)
    await w.payouts.runPayoutCycle()
    const trace = await w.db.all<{ payout_id: number; allocation_id: number; payment_id: number; provider_payment_id: string }>(
      `SELECT p.id payout_id, pi.allocation_id, a.payment_id, sp.provider_payment_id
       FROM payouts p JOIN payout_items pi ON pi.payout_id = p.id
       JOIN revenue_allocations a ON a.id = pi.allocation_id
       JOIN subscription_payments sp ON sp.id = a.payment_id WHERE p.id = 1`
    )
    expect(trace).toEqual([{ payout_id: 1, allocation_id: 1, payment_id: 1, provider_payment_id: 'pi_fund' }])
    const events = await w.db.all<{ event: string }>(`SELECT event FROM ledger_events WHERE payout_id = 1 ORDER BY id`)
    expect(events.map((e) => e.event)).toEqual(['payout.claimed', 'payout.provider_called', 'payout.succeeded'])
  })
})
