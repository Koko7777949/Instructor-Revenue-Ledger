# Architecture — Instructor Revenue Ledger

This document maps every section of the *Engineering Documentation Pack v1.0* to the code that implements it, and spells out the one place where the port deliberately differs (database locking primitive).

## 0. Spec → code map

| Spec section | Concept | Implementation |
|---|---|---|
| §3.1 Integer minor units | money is `INTEGER`, never float | `src/domain/money.ts` (`assertMinor`, `formatMinor` is display-only) ; all DB money columns `INTEGER` + `CHECK >= 0` |
| §3.2 Platform fee | `round_half_up(G*F/10000)`, fee rate stored on payment | `platformFee()` / `splitGross()` ; `subscription_payments.platform_fee_bps` + `CHECK (gross = fee + distributable)` |
| §3.3 Largest-remainder allocation | floor shares, leftover to largest remainder, tie → id asc | `src/domain/allocator.ts` `allocateLargestRemainder()` (BigInt numerators, self-checks `Σ == D`) |
| §4 Schema | 11 tables, uniques, FKs, indexes | `migrations/0001_initial_schema.sql` |
| §5 Recognition | straight-line daily, half-open UTC term, delta posting | `src/domain/recognition.ts` ; `src/services/recognition-service.ts` |
| §6 Refunds | unused-time only, proportional to remaining unearned, excess platform-side | `src/domain/refund.ts` `planRefund()` ; `src/services/refund-service.ts` |
| §7.2 `revenue:payouts` | find payable instructors, one job each | `PayoutService.runPayoutCycle()` ← `POST /api/ops/payouts/run` |
| §7.3 `PrepareInstructorPayout` | recognize → lock → claim → create payout + items → reserve | `PayoutService.plan()` + `commit()` (= `prepare()`) |
| §7.3 `ProcessInstructorPayout` | provider call with stable key, then one legal transition | `PayoutService.process()` |
| §7.3 `ReconcilePayout` | status lookup for VERIFY / stale PROCESSING | `PayoutService.reconcileDue()` / `reconcileOne()` |
| §8 Mock provider | 6 outcomes incl. TIMEOUT_AFTER_SUCCESS, own ledger | `src/services/mock-provider.ts` + table `mock_provider_transactions` |
| §8.3 Crash windows | replay-safe at every point | tests in `tests/feature/payouts.test.ts` ("crash BEFORE provider call", "stale PROCESSING", "replay finds provider record") |
| §9 Idempotency & invariants | uniqueness + terminal-state checks + CAS | partial unique index `uq_payouts_one_active_per_instructor`, `guard()` statements, `CHECK` constraints |
| §10 Testing | unit + DB-backed feature, 7 required behaviours | `tests/unit/*`, `tests/feature/*` (73 tests) |
| §11 Filament screens | read-only balances + payout history + drill-down | `src/views/dashboard.tsx` + `public/static/app.js` (no pay/retry/edit actions) |
| §12 Scaling | bounded batches, instructor-scoped work, no per-day rows | `recognizeAll(limit)`, `runPayoutCycle({limit})`, `reconcileDue(limit)` |
| §13 Observability | structured events with consistent names | `src/services/audit.ts` → `ledger_events`, written in the *same* atomic batch as the transition |
| §14 Security | no hard deletes, validate amounts, read-only UI | FKs `ON DELETE RESTRICT`, `CHECK (amount_minor > 0)` on payouts, status transitions only |

## 1. Layering

```
src/domain/      pure functions, zero I/O     ← unit tests
src/services/    orchestration over Db port   ← DB-backed feature tests (better-sqlite3)
src/db/          Db port + D1 / sqlite adapters
src/routes/      Hono JSON API (reads + "commands"/"jobs" as ops endpoints)
src/views/       read-only SPA shell
```

Everything money-related goes through services; nothing in routes touches balances directly. This is the spec's answer to "balance snapshot can drift if code bypasses services" (§18).

## 2. The payout lifecycle, end to end

```
runPayoutCycle()
 ├─ recognizeAll(asOf)            delta-post earned revenue per allocation (CAS on recognized_minor)
 └─ for each instructor with earned - paid - reserved > 0:
      prepare()
       ├─ plan()    read-only: active payout? balance? eligible allocations? drift check
       └─ commit()  ONE atomic batch:
             guard  balance.version == planned
             guard  no active payout for instructor
             INSERT payouts (PENDING, stable idempotency_key)
             ∀ item: guard alloc.paid/reserved unchanged → INSERT payout_items → alloc.reserved += amt
             balance.reserved += total ; version++
             INSERT ledger_events(payout.claimed)
      process(payoutId)
       ├─ terminal?  → payout.retry_noop, return (no provider call)
       ├─ VERIFY?    → reconcileOne() (status lookup, never re-create)
       ├─ UPDATE … SET status='PROCESSING' WHERE status IN (PENDING,PROCESSING)   ← claim
       ├─ provider.createPayout(idempotency_key, …)          ← NO db batch open here
       └─ outcome → exactly one of:
             SUCCESS           finalizeSuccess()  guard non-terminal → SUCCEEDED, items PAID, alloc.paid += / reserved -=, balance.paid += / reserved -=
             PERMANENT_FAILURE finalizeFailure()  guard non-terminal → FAILED, items RELEASED, alloc.reserved -=, balance.reserved -=
             TIMEOUT           markVerify()       PROCESSING → VERIFY, next_check_at = now + backoff, reservation KEPT
reconcileDue()
 └─ VERIFY due by next_check_at, or PROCESSING older than processing_stale_seconds:
      provider.getPayoutStatus(key) →
        STATUS_SUCCEEDED → finalizeSuccess()   (idempotent)
        STATUS_FAILED    → finalizeFailure()
        STATUS_NOT_FOUND → finalizeFailure()   (provider never saw the key ⇒ nothing moved)
        STATUS_UNKNOWN   → stay VERIFY, attempt++, exponential backoff
```

**Safety property (§8.3):** a timeout is never treated as evidence that money did not move. `TIMEOUT → VERIFY` keeps the reservation; only a *definitive* FAILED / NOT_FOUND releases it.

## 3. Locking on D1 — the one deliberate deviation

The spec uses MySQL `SELECT … FOR UPDATE` on `instructor_balances` inside a short transaction. Cloudflare D1 exposes no interactive transactions, but `D1Database.batch()` is **atomic**: every statement applies or none does.

We therefore express each money-moving transition as a single batch whose first statements are **guards**:

```sql
INSERT INTO tx_guard (k) SELECT 'GUARD_FAILED' WHERE NOT (<precondition>)
-- tx_guard has CHECK (k = 'LOCK'); inserting 'GUARD_FAILED' violates it → whole batch rolls back
```

Preconditions used:

| Transition | Guard(s) |
|---|---|
| recognition post | `revenue_allocations.recognized_minor == value read` |
| refund apply | `(recognized_minor, refunded_minor) == values read` |
| payout commit | `instructor_balances.version == read` · no active payout · each allocation's `(paid, reserved)` unchanged |
| finalize success / failure | `payouts.status IN ('PROCESSING','VERIFY')` |

On guard failure the service either retries with fresh reads (recognition, refund, intake) or exits safely (payout commit — "second worker sees no remaining payable amount or an already-active payout", §10.4). The partial unique index on `payouts(instructor_id) WHERE status IN (active)` is the belt to that suspenders: even a bypassing writer cannot create a second active payout.

The spec's own words justify this: *"The authoritative guard is database state plus uniqueness constraints"* (§9.1). The queue-level `WithoutOverlapping` lock is replaced by the request-scoped `payouts_lock` row used by the lazy scheduler; it is advisory, exactly as the spec intends.

## 4. Invariants and where they are enforced

| Invariant | DB | Service | Test |
|---|---|---|---|
| Σ allocations = distributable | — (checked by `/api/integrity`) | `allocateLargestRemainder` throws otherwise | `allocator.test.ts`, `integrity` |
| `recognized + refunded ≤ allocated` | `CHECK` | recognition base = allocated − refunded | `recognition.test.ts`, refund tests |
| `paid + reserved ≤ recognized` (per allocation) | `CHECK` | plan() only claims `recognized − paid − reserved` | "balance invariant" test |
| `paid + reserved ≤ earned` (balance) | `CHECK` | commit guards + drift check | integrity endpoint |
| one active payout per instructor | partial `UNIQUE` | plan()/commit() guard | "DB-level guard" test |
| one provider tx per idempotency key | `UNIQUE(payouts.idempotency_key)`, `UNIQUE(provider_transaction_id)`, provider ledger PK | stable key reused on retry/reconcile | "timeout after success", "replay" tests |
| terminal states are final | — | `finalize*` guard on non-terminal; `process()` short-circuits | "second process() is a no-op" |
| completed payout is explainable | FKs payouts→items→allocations→payments | `/api/payouts/:id` joins | "can be explained" test |

## 5. Scheduling without cron

Hosted deploy forbids `triggers`. `src/index.tsx` runs the daily cycle lazily: on `GET /api/summary`, if `settings.auto_schedule = 'on'` and `payouts_last_run` is older than 24h, it takes a 10-minute advisory lock row and runs `runPayoutCycle()` + `reconcileDue()` in `waitUntil()` so the response is never blocked. On BYOK Cloudflare this can be swapped for a `scheduled()` handler with no service changes.

## 6. Known limitations (carried from spec §18)
- Single currency per instructor balance.
- No tax / chargeback / negative adjustment ledger.
- Mock provider is deterministic, not network-realistic.
- Recognition is computed lazily during payout preparation (plus `POST /api/ops/recognize`), not continuously.
