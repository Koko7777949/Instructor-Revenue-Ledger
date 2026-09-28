/**
 * Demo seed: a handful of instructors, plans, students, and subscriptions spread over time so the
 * dashboard shows earned / reserved / paid balances immediately. Idempotent (safe to call twice).
 */
import type { Db } from '../db'
import { SubscriptionService } from './subscription-service'

export async function seedDemo(db: Db, now: Date): Promise<{ seeded: boolean }> {
  const existing = await db.first<{ n: number }>(`SELECT COUNT(*) n FROM instructors`)
  if ((existing?.n ?? 0) > 0) return { seeded: false }

  const people = [
    ['ada@ledger.dev', 'Ada Lovelace', 'instructor'],
    ['grace@ledger.dev', 'Grace Hopper', 'instructor'],
    ['linus@ledger.dev', 'Linus Torvalds', 'instructor'],
    ['margaret@ledger.dev', 'Margaret Hamilton', 'instructor'],
    ['kero@student.dev', 'Kero', 'student'],
    ['sam@student.dev', 'Sam Rivera', 'student'],
    ['jo@student.dev', 'Jo Chen', 'student'],
    ['mika@student.dev', 'Mika Ortiz', 'student'],
    ['ops@ledger.dev', 'Ops Admin', 'admin']
  ]
  await db.batch(people.map(([email, name, role]) => ({ sql: `INSERT INTO users (email, name, role) VALUES (?, ?, ?)`, params: [email, name, role] })))

  const instructorUsers = await db.all<{ id: number; email: string }>(`SELECT id, email FROM users WHERE role = 'instructor' ORDER BY id`)
  await db.batch(
    instructorUsers.map((u, i) => ({
      sql: `INSERT INTO instructors (user_id, provider_account_id, status) VALUES (?, ?, 'active')`,
      params: [u.id, `acct_${u.email.split('@')[0]}_${(i + 1).toString().padStart(3, '0')}`]
    }))
  )
  await db.batch([
    { sql: `INSERT INTO plans (code, name, term_months, price_minor, currency, platform_fee_bps, active) VALUES ('monthly', 'Monthly Access', 1, 4999, 'USD', 2000, 1)` },
    { sql: `INSERT INTO plans (code, name, term_months, price_minor, currency, platform_fee_bps, active) VALUES ('quarterly', 'Quarterly Access', 3, 12995, 'USD', 2000, 1)` },
    { sql: `INSERT INTO plans (code, name, term_months, price_minor, currency, platform_fee_bps, active) VALUES ('annual', 'Annual Access', 12, 39900, 'USD', 1500, 1)` }
  ])

  const instructors = await db.all<{ id: number }>(`SELECT id FROM instructors ORDER BY id`)
  const students = await db.all<{ id: number }>(`SELECT id FROM users WHERE role = 'student' ORDER BY id`)
  const plans = await db.all<{ id: number; code: string }>(`SELECT id, code FROM plans`)
  const plan = (code: string) => plans.find((p) => p.code === code)!.id
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)

  const subs = new SubscriptionService(db)
  const I = instructors.map((i) => i.id)
  const S = students.map((s) => s.id)

  const scenarios: Array<{ user: number; plan: number; paidDaysAgo: number; participants: { instructorId: number; weight?: number }[] }> = [
    { user: S[0], plan: plan('annual'), paidDaysAgo: 200, participants: [{ instructorId: I[0] }, { instructorId: I[1] }, { instructorId: I[2] }] },
    { user: S[1], plan: plan('quarterly'), paidDaysAgo: 45, participants: [{ instructorId: I[0], weight: 2 }, { instructorId: I[3], weight: 1 }] },
    { user: S[2], plan: plan('monthly'), paidDaysAgo: 20, participants: [{ instructorId: I[1] }, { instructorId: I[2] }, { instructorId: I[3] }] },
    { user: S[3], plan: plan('quarterly'), paidDaysAgo: 10, participants: [{ instructorId: I[2] }] },
    { user: S[0], plan: plan('monthly'), paidDaysAgo: 40, participants: [{ instructorId: I[3] }, { instructorId: I[0] }] },
    { user: S[1], plan: plan('annual'), paidDaysAgo: 3, participants: [{ instructorId: I[0] }, { instructorId: I[1] }, { instructorId: I[2] }, { instructorId: I[3] }] }
  ]
  let n = 0
  for (const s of scenarios) {
    n++
    await subs.recordPayment({
      userId: s.user,
      planId: s.plan,
      providerPaymentId: `pi_demo_${n.toString().padStart(4, '0')}`,
      participants: s.participants,
      paidAt: daysAgo(s.paidDaysAgo)
    })
  }
  return { seeded: true }
}
