import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { d1Db } from './db/d1'
import { buildServices, type Services } from './services/container'
import { api } from './routes/api'
import { dashboardHtml } from './views/dashboard'

type Bindings = { DB: D1Database }
type Env = { Bindings: Bindings; Variables: { svc: Services } }

const app = new Hono<Env>()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './public' }))

// Build the service container per request (Workers are stateless).
app.use('*', async (c, next) => {
  if (!c.env?.DB) return c.text('D1 binding "DB" missing. Run with --d1=webapp-production --local', 500)
  c.set('svc', buildServices(d1Db(c.env.DB)))
  await next()
})

/**
 * Lazy scheduler (hosted deploy has no cron triggers): if the payout cycle has not run in the last
 * 24h, catch up on this request, in the background, without blocking the response.
 * Equivalent of `Schedule::command('revenue:payouts')->dailyAt('02:00')->onOneServer()`.
 */
app.use('/api/*', async (c, next) => {
  await next()
  if (c.req.method !== 'GET' || !c.req.path.startsWith('/api/summary')) return
  const { db, payouts } = c.get('svc')
  const work = (async () => {
    const auto = await db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'auto_schedule'`)
    if (auto?.value !== 'on') return
    const last = await db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'payouts_last_run'`)
    const lastAt = last ? new Date(last.value).getTime() : 0
    if (Date.now() - lastAt < 24 * 3600 * 1000) return
    // Cheap distributed lock via unique key row; expires after 10 minutes.
    const lock = await db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('payouts_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE settings.updated_at < ?`,
      [crypto.randomUUID(), new Date().toISOString(), new Date(Date.now() - 600_000).toISOString()]
    )
    if (lock.changes === 0) return
    try {
      await payouts.runPayoutCycle()
      await payouts.reconcileDue()
    } finally {
      await db.run(`DELETE FROM settings WHERE key = 'payouts_lock'`)
    }
  })().catch((e) => console.error('lazy scheduler failed', e))
  c.executionCtx?.waitUntil?.(work)
})

app.route('/api', api)

app.get('/api/health', (c) => c.json({ ok: true, service: 'instructor-revenue-ledger' }))

app.get('/', (c) => c.html(dashboardHtml()))
app.get('/payouts/:id', (c) => c.html(dashboardHtml()))
app.get('/instructors/:id', (c) => c.html(dashboardHtml()))
app.get('/payments/:id', (c) => c.html(dashboardHtml()))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message }, 500)
})

export default app
