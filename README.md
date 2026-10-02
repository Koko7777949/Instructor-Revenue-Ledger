# Instructor Revenue Ledger

A production-minded financial subsystem for an online-courses LMS: students prepay a subscription term, the platform recognizes instructor revenue straight-line over that term, and settles it through an unreliable external payout provider — **without ever paying twice, over-reserving, or losing money on a timeout.**

Faithful port of the *Instructor Revenue Ledger – Engineering Documentation Pack v1.0* (Laravel/Filament design) to **Hono + TypeScript + Cloudflare D1**, keeping every table, invariant, algorithm, and state transition from the spec.

## Project Overview
- **Name**: webapp (Instructor Revenue Ledger)
- **Goal**: Deterministic, auditable, idempotent instructor payouts from prepaid subscription revenue.
- **Core properties**
  - Money is **integer minor units** (cents); no floating point anywhere in the money path.
  - **Weighted largest-remainder allocation** — every payment's shares sum exactly to the distributable amount; ties break on instructor id.
  - **Straight-line daily recognition** over a half-open `[starts_at, ends_at)` UTC term; only the delta is ever posted.
  - **Unused-time-only refunds** — earned revenue is never clawed back; excess is recorded platform-side.
  - **Payout state machine** `PENDING → PROCESSING → SUCCEEDED | FAILED | VERIFY`, with `VERIFY` as first-class "money may have moved" state.
  - **Stable idempotency key per payout**; retries and reconciliation reuse it — one provider transaction per intent, proven by tests.
  - **Two-layer concurrency control**: partial `UNIQUE` index (one active payout per instructor) + compare-and-swap guards inside atomic D1 batches.
  - **Full trace**: `payout → payout_items → revenue_allocations → subscription_payments` plus a structured event log.

## URLs
- **Sandbox preview**: https://3000-inxh5xzdct5yymr8gfl0j-5185f4aa.sandbox.novita.ai
- **Health**: `GET /api/health`
- **Production**: not yet deployed (see *Deployment*)

## Currently Completed Features
| Area | Status |
|---|---|
| D1 schema — 11 spec tables + provider ledger, audit log, settings, tx guard; all UNIQUE/CHECK constraints | ✅ |
| Monetary model (`platformFee` half-up bps, `splitGross`) | ✅ |
| `RevenueAllocator` (weighted largest remainder, BigInt-safe) | ✅ |
| `RevenueRecognition` (earned-to-date, delta posting, leap-year safe) | ✅ |
| Refund planning + distribution proportional to remaining unearned | ✅ |
| Subscription intake with participant snapshot, idempotent on provider payment id | ✅ |
| `PayoutService`: prepare (claim + reserve), process (provider call outside DB tx), finalize (exactly-once), reconcile (backoff) | ✅ |
| `MockPayoutProvider` with SUCCESS / PERMANENT_FAILURE / TIMEOUT_AFTER_SUCCESS / TIMEOUT_NO_EFFECT / STATUS_UNKNOWN | ✅ |
| `revenue:payouts` command equivalent (`POST /api/ops/payouts/run`) + lazy 24h scheduler | ✅ |
| Read-only dashboard: overview, instructor balances, payout history (filters), payout drill-down, payments, audit log | ✅ |
| Ops console: run cycle, reconcile, replay job, provider scenario, time travel, simulate payment/refund webhooks | ✅ |
| Integrity endpoint (snapshot vs allocations, Σ allocations = distributable, one provider tx per key) | ✅ |
| **73 Vitest tests** (unit + DB-backed feature) incl. all 7 required behaviors of §10.2 | ✅ |

## Functional Entry Points

### Dashboard (read-only, hash-routed SPA)
| Route | Screen |
|---|---|
| `/#/overview` | Balances, cash received, payout states, integrity |
| `/#/instructors` · `/#/instructors/:id` | Balance table (Earned / Reserved / Paid / Available / Last payout) → allocations with recognition progress |
| `/#/payouts?status=&from=&to=` · `/#/payouts/:id` | Filterable history → items → underlying allocations, provider-side record, event log |
| `/#/payments` · `/#/payments/:id` | Payments, fee split, allocation split with weights, refunds |
| `/#/events` | Structured audit log |
| `/#/ops` | Operator console (commands, jobs, scenario, clock, webhooks) |

### JSON API — reads
| Method & path | Description |
|---|---|
| `GET /api/summary` | Aggregate balances, payout counts by status, provider scenario, clock |
| `GET /api/instructors` · `GET /api/instructors/:id` | Balance snapshot rows / allocations + payouts for one instructor |
| `GET /api/payouts?status=&from=&to=&instructor=&limit=` · `GET /api/payouts/:id` | Payout history / full drill-down (`items`, `events`, `providerRecord`) |
| `GET /api/payments` · `GET /api/payments/:id` | Payment facts / allocation split + refunds |
| `GET /api/events?limit=&payoutId=&instructorId=&event=` | Audit log (filterable) |
| `GET /api/integrity` | Invariant checks; `ok: true` means no drift |
| `GET /api/plans` · `GET /api/students` | Reference data |

### JSON API — ops (the "artisan commands" and queue jobs)
| Method & path | Laravel equivalent | Body |
|---|---|---|
| `POST /api/ops/payouts/run` | `php artisan revenue:payouts [--instructor=ID]` | `{ instructorId?, limit? }` |
| `POST /api/ops/payouts/prepare/:instructorId` | `PrepareInstructorPayout` job | – |
| `POST /api/ops/payouts/:id/process` | `ProcessInstructorPayout` job (safe to replay) | – |
| `POST /api/ops/reconcile?force=1` | `ReconcilePayout` sweep | – |
| `POST /api/ops/recognize` | recognize revenue as of clock | – |
| `POST /api/ops/payments` | settled-payment webhook | `{ userId, planId, participants:[{instructorId, weight?}], providerPaymentId?, paidAt?, grossMinor? }` |
| `POST /api/ops/refunds` | refund webhook | `{ paymentId, refundMinor, providerRef? }` |
| `GET/POST /api/ops/provider` | switch mock scenario | `{ scenario }` |
| `POST /api/ops/clock` | freeze / advance clock | `{ now: ISO \| null }` or `{ advanceDays }` |
| `POST /api/ops/seed` · `POST /api/ops/reset` | demo data | – |

## Data Architecture
- **Storage**: Cloudflare D1 (SQLite). Local dev uses wrangler's `--local` SQLite in `.wrangler/state`; tests use in-memory `better-sqlite3` against the *same* migration file.
- **Immutable facts**: `subscriptions`, `subscription_payments`, `subscription_participants`, `revenue_allocations.allocated_minor`, `refunds`, `refund_allocations`.
- **Operational progress**: `revenue_allocations.{recognized,paid,reserved,refunded}_minor`, `payouts`, `payout_items`.
- **Snapshot**: `instructor_balances` (earned / paid / reserved + `version`), maintained transactionally; `/api/integrity` proves it equals Σ allocations.
- **Audit**: `ledger_events` (`payout.claimed`, `payout.provider_called`, `payout.succeeded`, `payout.failed`, `payout.verification_started`, `payout.reconciled`, …).
- **Mock provider ledger**: `mock_provider_transactions` keyed by idempotency key — this is how the mock can "move money" while the caller times out.
- **Key constraints**: `UNIQUE(payouts.idempotency_key)`, `UNIQUE(payouts.provider_transaction_id)`, partial `UNIQUE(payouts.instructor_id) WHERE status IN (PENDING,PROCESSING,VERIFY)`, `UNIQUE(payment_id, instructor_id)`, `CHECK(paid + reserved <= recognized)`, `CHECK(recognized + refunded <= allocated)`, `CHECK(paid + reserved <= earned)` on balances.

### Concurrency on D1 (vs. `SELECT … FOR UPDATE`)
D1 has no interactive transactions, but `batch()` is atomic. Every money-moving transition is one batch that starts with **guard statements** — `INSERT INTO tx_guard SELECT 'GUARD_FAILED' WHERE NOT (<precondition>)` — which violate a CHECK constraint (and roll back the whole batch) when a precondition read earlier is no longer true (balance `version`, allocation `paid/reserved`, payout non-terminal). Losers retry with fresh reads or exit safely. This is the doc's own "authoritative guard is database state plus uniqueness constraints" (§9.1), made literal.

## User Guide (5-minute review script, §16)
1. Open the preview → **Seed demo data** (Overview banner or Ops console).
2. **Instructor balances** — all *Earned* is 0 until recognition runs; **Ops → Recognize** posts earned-to-date for 200/45/20/10/40/3-day-old subscriptions.
3. **Ops → Run cycle** — one payout per instructor goes `PENDING → SUCCEEDED`. Run it **again**: `candidates: 0`. Replay `Process` on a succeeded payout: `providerCalled: false`.
4. **Ops → Clock +30d**, scenario **TIMEOUT_AFTER_SUCCESS**, **Run cycle** — payouts land in **VERIFY**, *Reserved* stays > 0. Open one: provider record shows `SUCCEEDED`, `call_count: 1`.
5. **Reconcile** — status lookup finds SUCCESS and finalizes; still exactly one provider tx per key. Overview → *Integrity: ALL INVARIANTS HOLD*.
6. Scenario **PERMANENT_FAILURE**, +30d, run → `FAILED`, reservation released, *Available* is back. Switch to **SUCCESS**, run → paid with **new** payout ids.
7. **Simulate refund** on a payment → only the unearned pool is taken from instructors; excess is `platform_excess_minor`.

## Development
```bash
npm install
npm run build                         # vite → dist/_worker.js
npm run db:migrate:local              # apply migrations/*.sql to local D1
pm2 start ecosystem.config.cjs        # wrangler pages dev on :3000 with --d1 --local
npm test                              # 73 vitest tests (unit + DB-backed feature)
```

## Features Not Yet Implemented / Next Steps
- Production deploy (create D1 `webapp-production`, put its id in `wrangler.jsonc`, `npm run db:migrate:prod`, `npm run deploy:prod`).
- Auth for the ops console (currently open — it is a demo surface; gate `/api/ops/*` and the dashboard behind hosted access rules before real use).
- Multi-currency balances (one balance per instructor **+ currency**); currently single platform currency per instructor.
- Signed adjustment ledger / chargeback & clawback workflow (explicit non-goal in the spec).
- Real provider adapter behind `PayoutProvider`; contract + chaos tests against a sandbox.
- Cron-based scheduling on BYOK Cloudflare (`triggers`) instead of the lazy 24h catch-up on hosted deploy.
- Alerting when a payout stays in `VERIFY` beyond SLA (data is there: `next_check_at`, `attempt_count`).

## Deployment
- **Platform**: Cloudflare Pages + D1
- **Status**: ✅ Running in sandbox (local D1) · ❌ Not yet deployed to production
- **Tech Stack**: Hono 4 · TypeScript · Cloudflare D1 · Vite · Vitest + better-sqlite3 · Tailwind (CDN) · vanilla JS SPA
- **Last Updated**: 2026-10-02

See `docs/ARCHITECTURE.md` for the design → code mapping and `docs/AI_USAGE.md` for the disclosure.
