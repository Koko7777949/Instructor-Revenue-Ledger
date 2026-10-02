/**
 * JSON API. Read endpoints power the dashboard; "ops" endpoints are the HTTP equivalents of the
 * artisan commands / queue jobs (revenue:payouts, ProcessInstructorPayout, ReconcilePayout) plus
 * demo controls (mock provider scenario, frozen clock, seed).
 */
import { Hono } from 'hono'
import type { Services } from '../services/container'
import { PROVIDER_SCENARIOS, isProviderScenario } from '../domain/provider'
import { seedDemo } from '../services/seed'

type Env = { Variables: { svc: Services } }

export const api = new Hono<Env>()

// ------------------------------------------------------------------ reads

api.get('/summary', async (c) => {
  const { db, clock } = c.get('svc')
  const [bal, pay, pending, scenario, frozen, lastRun, subs] = await Promise.all([
    db.first<{ earned: number; paid: number; reserved: number; instructors: number }>(
      `SELECT COALESCE(SUM(earned_minor),0) earned, COALESCE(SUM(paid_minor),0) paid, COALESCE(SUM(reserved_minor),0) reserved, COUNT(*) instructors FROM instructor_balances`
    ),
    db.all<{ status: string; n: number; amount: number }>(`SELECT status, COUNT(*) n, COALESCE(SUM(amount_minor),0) amount FROM payouts GROUP BY status`),
    db.first<{ n: number }>(`SELECT COUNT(*) n FROM payouts WHERE status IN ('PENDING','PROCESSING','VERIFY')`),
    db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'provider_scenario'`),
    db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'frozen_now'`),
    db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'payouts_last_run'`),
    db.first<{ n: number; gross: number; fee: number; dist: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(gross_minor),0) gross, COALESCE(SUM(platform_fee_minor),0) fee, COALESCE(SUM(distributable_minor),0) dist FROM subscription_payments`
    )
  ])
  const unrecognized = await db.first<{ n: number }>(`SELECT COALESCE(SUM(allocated_minor - refunded_minor - recognized_minor),0) n FROM revenue_allocations`)
  return c.json({
    now: (await clock.now()).toISOString(),
    frozenNow: frozen?.value ?? null,
    providerScenario: scenario?.value ?? 'SUCCESS',
    payoutsLastRun: lastRun?.value ?? null,
    balances: { ...bal, available: (bal?.earned ?? 0) - (bal?.paid ?? 0) - (bal?.reserved ?? 0) },
    unrecognizedMinor: unrecognized?.n ?? 0,
    payments: subs,
    payoutsByStatus: pay,
    activePayouts: pending?.n ?? 0
  })
})

api.get('/instructors', async (c) => {
  const { db } = c.get('svc')
  const rows = await db.all(
    `SELECT i.id, u.name, u.email, i.provider_account_id, i.status,
            COALESCE(b.currency, 'USD') currency,
            COALESCE(b.earned_minor,0) earned_minor, COALESCE(b.reserved_minor,0) reserved_minor, COALESCE(b.paid_minor,0) paid_minor,
            COALESCE(b.earned_minor,0) - COALESCE(b.paid_minor,0) - COALESCE(b.reserved_minor,0) available_minor,
            (SELECT COALESCE(SUM(allocated_minor - refunded_minor),0) FROM revenue_allocations a WHERE a.instructor_id = i.id) lifetime_allocated_minor,
            lp.id last_payout_id, lp.status last_payout_status, lp.amount_minor last_payout_amount, lp.updated_at last_payout_at
     FROM instructors i
     JOIN users u ON u.id = i.user_id
     LEFT JOIN instructor_balances b ON b.instructor_id = i.id
     LEFT JOIN payouts lp ON lp.id = (SELECT id FROM payouts p WHERE p.instructor_id = i.id ORDER BY id DESC LIMIT 1)
     ORDER BY i.id`
  )
  return c.json({ instructors: rows })
})

api.get('/instructors/:id', async (c) => {
  const { db } = c.get('svc')
  const id = Number(c.req.param('id'))
  const instructor = await db.first(
    `SELECT i.*, u.name, u.email, b.earned_minor, b.paid_minor, b.reserved_minor, b.currency, b.version, b.updated_at balance_updated_at
     FROM instructors i JOIN users u ON u.id = i.user_id LEFT JOIN instructor_balances b ON b.instructor_id = i.id WHERE i.id = ?`,
    [id]
  )
  if (!instructor) return c.json({ error: 'not found' }, 404)
  const allocations = await db.all(
    `SELECT a.*, sp.provider_payment_id, sp.gross_minor payment_gross_minor, sp.status payment_status, p.code plan_code, sub.user_id student_id, u.name student_name
     FROM revenue_allocations a
     JOIN subscription_payments sp ON sp.id = a.payment_id
     JOIN subscriptions sub ON sub.id = sp.subscription_id
     JOIN plans p ON p.id = sub.plan_id
     JOIN users u ON u.id = sub.user_id
     WHERE a.instructor_id = ? ORDER BY a.id DESC`,
    [id]
  )
  const payouts = await db.all(`SELECT * FROM payouts WHERE instructor_id = ? ORDER BY id DESC LIMIT 50`, [id])
  return c.json({ instructor, allocations, payouts })
})

api.get('/payouts', async (c) => {
  const { db } = c.get('svc')
  const status = c.req.query('status')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const instructor = c.req.query('instructor')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const where: string[] = []
  const params: (string | number)[] = []
  if (status) { where.push('p.status = ?'); params.push(status) }
  if (instructor) { where.push('p.instructor_id = ?'); params.push(Number(instructor)) }
  if (from) { where.push('p.created_at >= ?'); params.push(new Date(from).toISOString()) }
  if (to) { where.push('p.created_at <= ?'); params.push(new Date(to).toISOString()) }
  params.push(limit)
  const rows = await db.all(
    `SELECT p.*, u.name instructor_name, (SELECT COUNT(*) FROM payout_items pi WHERE pi.payout_id = p.id) item_count
     FROM payouts p JOIN instructors i ON i.id = p.instructor_id JOIN users u ON u.id = i.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT ?`,
    params
  )
  return c.json({ payouts: rows })
})

api.get('/payouts/:id', async (c) => {
  const { db } = c.get('svc')
  const id = Number(c.req.param('id'))
  const payout = await db.first(
    `SELECT p.*, u.name instructor_name, u.email instructor_email, i.provider_account_id
     FROM payouts p JOIN instructors i ON i.id = p.instructor_id JOIN users u ON u.id = i.user_id WHERE p.id = ?`,
    [id]
  )
  if (!payout) return c.json({ error: 'not found' }, 404)
  const items = await db.all(
    `SELECT pi.*, a.allocated_minor, a.recognized_minor, a.paid_minor alloc_paid_minor, a.reserved_minor alloc_reserved_minor, a.refunded_minor,
            a.term_start_at, a.term_end_at, a.payment_id, sp.provider_payment_id, sp.gross_minor payment_gross_minor, pl.code plan_code, su.name student_name
     FROM payout_items pi
     JOIN revenue_allocations a ON a.id = pi.allocation_id
     JOIN subscription_payments sp ON sp.id = a.payment_id
     JOIN subscriptions s ON s.id = sp.subscription_id
     JOIN plans pl ON pl.id = s.plan_id
     JOIN users su ON su.id = s.user_id
     WHERE pi.payout_id = ? ORDER BY pi.id`,
    [id]
  )
  const events = await db.all(`SELECT * FROM ledger_events WHERE payout_id = ? ORDER BY id`, [id])
  const providerRecord = await db.first(`SELECT * FROM mock_provider_transactions WHERE idempotency_key = ?`, [(payout as { idempotency_key: string }).idempotency_key])
  return c.json({ payout, items, events, providerRecord })
})

api.get('/payments', async (c) => {
  const { db } = c.get('svc')
  const rows = await db.all(
    `SELECT sp.*, s.starts_at, s.ends_at, s.status subscription_status, pl.code plan_code, pl.term_months, u.name student_name,
            (SELECT COUNT(*) FROM revenue_allocations a WHERE a.payment_id = sp.id) participant_count,
            (SELECT COALESCE(SUM(refund_minor),0) FROM refunds r WHERE r.payment_id = sp.id AND r.status = 'processed') refunded_minor
     FROM subscription_payments sp JOIN subscriptions s ON s.id = sp.subscription_id JOIN plans pl ON pl.id = s.plan_id JOIN users u ON u.id = s.user_id
     ORDER BY sp.id DESC LIMIT 200`
  )
  return c.json({ payments: rows })
})

api.get('/payments/:id', async (c) => {
  const { db } = c.get('svc')
  const id = Number(c.req.param('id'))
  const payment = await db.first(`SELECT sp.*, s.starts_at, s.ends_at, pl.code plan_code, u.name student_name FROM subscription_payments sp JOIN subscriptions s ON s.id = sp.subscription_id JOIN plans pl ON pl.id = s.plan_id JOIN users u ON u.id = s.user_id WHERE sp.id = ?`, [id])
  if (!payment) return c.json({ error: 'not found' }, 404)
  const allocations = await db.all(`SELECT a.*, u.name instructor_name, sp2.weight FROM revenue_allocations a JOIN instructors i ON i.id = a.instructor_id JOIN users u ON u.id = i.user_id LEFT JOIN subscription_participants sp2 ON sp2.instructor_id = a.instructor_id AND sp2.subscription_id = ? WHERE a.payment_id = ? ORDER BY a.instructor_id`, [(payment as { subscription_id: number }).subscription_id, id])
  const refunds = await db.all(`SELECT r.*, (SELECT json_group_array(json_object('allocation_id', ra.allocation_id, 'amount_minor', ra.amount_minor)) FROM refund_allocations ra WHERE ra.refund_id = r.id) lines FROM refunds r WHERE r.payment_id = ? ORDER BY r.id`, [id])
  return c.json({ payment, allocations, refunds })
})

api.get('/events', async (c) => {
  const { db } = c.get('svc')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const where: string[] = []
  const params: (string | number)[] = []
  const payoutId = c.req.query('payoutId')
  const instructorId = c.req.query('instructorId')
  const event = c.req.query('event')
  if (payoutId) { where.push('payout_id = ?'); params.push(Number(payoutId)) }
  if (instructorId) { where.push('instructor_id = ?'); params.push(Number(instructorId)) }
  if (event) { where.push('event = ?'); params.push(event) }
  const rows = await db.all(
    `SELECT * FROM ledger_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
    [...params, limit]
  )
  return c.json({ events: rows })
})

api.get('/plans', async (c) => c.json({ plans: await c.get('svc').db.all(`SELECT * FROM plans ORDER BY id`) }))
api.get('/students', async (c) => c.json({ students: await c.get('svc').db.all(`SELECT id, name, email FROM users WHERE role = 'student' ORDER BY id`) }))

/** Integrity check: does the balance snapshot agree with the allocation rows? (§18 drift detection) */
api.get('/integrity', async (c) => {
  const { db } = c.get('svc')
  const rows = await db.all<Record<string, number>>(
    `SELECT b.instructor_id,
            b.earned_minor snap_earned, b.paid_minor snap_paid, b.reserved_minor snap_reserved,
            COALESCE(a.recognized,0) alloc_recognized, COALESCE(a.paid,0) alloc_paid, COALESCE(a.reserved,0) alloc_reserved
     FROM instructor_balances b
     LEFT JOIN (SELECT instructor_id, SUM(recognized_minor) recognized, SUM(paid_minor) paid, SUM(reserved_minor) reserved FROM revenue_allocations GROUP BY instructor_id) a
       ON a.instructor_id = b.instructor_id ORDER BY b.instructor_id`
  )
  const allocSums = await db.first<{ bad: number }>(
    `SELECT COUNT(*) bad FROM (SELECT sp.id FROM subscription_payments sp JOIN revenue_allocations a ON a.payment_id = sp.id GROUP BY sp.id HAVING SUM(a.allocated_minor) != sp.distributable_minor)`
  )
  const dupProvider = await db.first<{ bad: number }>(`SELECT COUNT(*) bad FROM (SELECT idempotency_key FROM mock_provider_transactions GROUP BY idempotency_key HAVING COUNT(*) > 1)`)
  const checks = rows.map((r) => ({
    ...r,
    ok: r.snap_earned === r.alloc_recognized && r.snap_paid === r.alloc_paid && r.snap_reserved === r.alloc_reserved
  }))
  return c.json({
    ok: checks.every((x) => x.ok) && (allocSums?.bad ?? 0) === 0 && (dupProvider?.bad ?? 0) === 0,
    balanceChecks: checks,
    paymentsWithBadAllocationSum: allocSums?.bad ?? 0,
    duplicateProviderTransactions: dupProvider?.bad ?? 0
  })
})

// ------------------------------------------------------------------ ops (the "artisan commands" + jobs)

/** php artisan revenue:payouts [--instructor=ID] */
api.post('/ops/payouts/run', async (c) => {
  const { payouts } = c.get('svc')
  const body = await c.req.json().catch(() => ({})) as { instructorId?: number; limit?: number }
  return c.json(await payouts.runPayoutCycle({ instructorId: body.instructorId, limit: body.limit }))
})

/** PrepareInstructorPayout job only (creates PENDING intent + reservation, no provider call) */
api.post('/ops/payouts/prepare/:instructorId', async (c) => {
  const { payouts } = c.get('svc')
  return c.json(await payouts.prepare(Number(c.req.param('instructorId'))))
})

/** ProcessInstructorPayout job for an existing payout (safe to replay) */
api.post('/ops/payouts/:id/process', async (c) => {
  const { payouts } = c.get('svc')
  return c.json(await payouts.process(Number(c.req.param('id'))))
})

/** ReconcilePayout sweep. Operator-triggered sweeps bypass the backoff schedule (?force=1, default on). */
api.post('/ops/reconcile', async (c) => {
  const { payouts } = c.get('svc')
  const force = c.req.query('force') !== '0'
  return c.json({ force, reconciled: await payouts.reconcileDue({ force }) })
})

/** Recognize revenue as of the current clock (normally done lazily in prepare) */
api.post('/ops/recognize', async (c) => {
  const { recognition, clock } = c.get('svc')
  const now = await clock.now()
  return c.json({ asOf: now.toISOString(), posted: await recognition.recognizeAll(now) })
})

/** Simulate a settled subscription payment webhook */
api.post('/ops/payments', async (c) => {
  const { subscriptions, clock } = c.get('svc')
  const b = await c.req.json() as { userId: number; planId: number; providerPaymentId?: string; participants: { instructorId: number; weight?: number }[]; paidAt?: string; grossMinor?: number }
  if (!b.userId || !b.planId || !Array.isArray(b.participants) || b.participants.length === 0) return c.json({ error: 'userId, planId, participants[] required' }, 400)
  const paidAt = b.paidAt ? new Date(b.paidAt) : await clock.now()
  try {
    const r = await subscriptions.recordPayment({
      userId: Number(b.userId), planId: Number(b.planId),
      providerPaymentId: b.providerPaymentId ?? `pi_${crypto.randomUUID().slice(0, 12)}`,
      participants: b.participants.map((p) => ({ instructorId: Number(p.instructorId), weight: p.weight ? Number(p.weight) : 1 })),
      paidAt, grossMinor: b.grossMinor
    })
    return c.json(r)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/** Simulate a provider refund webhook */
api.post('/ops/refunds', async (c) => {
  const { refunds, clock } = c.get('svc')
  const b = await c.req.json() as { paymentId: number; refundMinor: number; providerRef?: string }
  if (!b.paymentId || !Number.isInteger(b.refundMinor) || b.refundMinor <= 0) return c.json({ error: 'paymentId and positive integer refundMinor required' }, 400)
  try {
    return c.json(await refunds.recordRefund({ paymentId: Number(b.paymentId), refundMinor: b.refundMinor, providerRef: b.providerRef ?? `re_${crypto.randomUUID().slice(0, 12)}`, processedAt: await clock.now() }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/** Mock provider scenario switch */
api.get('/ops/provider', async (c) => c.json({ scenario: await c.get('svc').provider.currentScenario(), scenarios: PROVIDER_SCENARIOS }))
api.post('/ops/provider', async (c) => {
  const { db } = c.get('svc')
  const { scenario } = await c.req.json() as { scenario: string }
  if (!isProviderScenario(scenario)) return c.json({ error: `scenario must be one of ${PROVIDER_SCENARIOS.join(', ')}` }, 400)
  await db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('provider_scenario', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [scenario, new Date().toISOString()])
  return c.json({ scenario })
})

/** Frozen clock for deterministic demos: POST {"now": ISO} or {"advanceDays": n} or {"now": null} to unfreeze */
api.post('/ops/clock', async (c) => {
  const { db, clock } = c.get('svc')
  const b = await c.req.json() as { now?: string | null; advanceDays?: number }
  if (b.now === null) {
    await db.run(`DELETE FROM settings WHERE key = 'frozen_now'`)
    return c.json({ frozenNow: null, now: new Date().toISOString() })
  }
  let target: Date
  if (typeof b.advanceDays === 'number') target = new Date((await clock.now()).getTime() + b.advanceDays * 86_400_000)
  else if (b.now) target = new Date(b.now)
  else return c.json({ error: 'provide now (ISO|null) or advanceDays' }, 400)
  if (Number.isNaN(target.getTime())) return c.json({ error: 'invalid date' }, 400)
  await db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('frozen_now', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [target.toISOString(), new Date().toISOString()])
  return c.json({ frozenNow: target.toISOString() })
})

/** Seed demo data (idempotent) */
api.post('/ops/seed', async (c) => {
  const { db, clock } = c.get('svc')
  return c.json(await seedDemo(db, await clock.now()))
})

/** Danger zone for demos: wipe all ledger data (keeps schema + settings). */
api.post('/ops/reset', async (c) => {
  const { db } = c.get('svc')
  const tables = ['ledger_events', 'payout_items', 'payouts', 'refund_allocations', 'refunds', 'revenue_allocations', 'instructor_balances', 'subscription_participants', 'subscription_payments', 'subscriptions', 'plans', 'instructors', 'users', 'mock_provider_transactions']
  await db.batch([
    ...tables.map((t) => ({ sql: `DELETE FROM ${t}` })),
    { sql: `DELETE FROM sqlite_sequence` },
    { sql: `DELETE FROM settings WHERE key IN ('frozen_now', 'payouts_last_run')` },
    { sql: `UPDATE settings SET value = 'SUCCESS' WHERE key = 'provider_scenario'` }
  ])
  return c.json({ reset: true })
})
