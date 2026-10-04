# API Reference

All responses are JSON. Money fields end in `_minor` and are integer minor units (cents). Timestamps are ISO-8601 UTC.

Base URL in the sandbox: `https://3000-inxh5xzdct5yymr8gfl0j-5185f4aa.sandbox.novita.ai`

## Read endpoints

### `GET /api/health`
```json
{ "ok": true, "service": "instructor-revenue-ledger" }
```

### `GET /api/summary`
Aggregate balances, payout counts by status, provider scenario, clock and last cycle run.

```json
{
  "now": "2026-11-01T15:25:07.319Z",
  "providerScenario": "SUCCESS",
  "payoutsLastRun": "2026-11-01T15:25:07.319Z",
  "balances": { "earned": 45474, "paid": 37704, "reserved": 0, "instructors": 4, "available": 7770 },
  "payoutsByStatus": [ { "status": "FAILED", "n": 1, "amount": 2071 }, { "status": "SUCCEEDED", "n": 6, "amount": 37704 } ],
  "activePayouts": 0
}
```

### `GET /api/instructors`
Balance snapshot per instructor — the Filament "Instructor balance view" (§11.1).

| Field | Meaning |
|---|---|
| `earned_minor` | cumulative recognized revenue |
| `reserved_minor` | attached to a non-terminal payout |
| `paid_minor` | cumulative settled |
| available | `earned − reserved − paid` (computed client-side) |
| `last_payout_status`, `last_payout_amount`, `last_payout_at` | most recent payout |

### `GET /api/instructors/:id`
`{ instructor, allocations[], payouts[] }` — allocations include `allocated / recognized / paid / reserved / refunded` and term bounds.

### `GET /api/payouts`
Payout history (§11.2). Query params: `status`, `from`, `to`, `instructor`, `limit`.

### `GET /api/payouts/:id`
Full drill-down: `{ payout, items[], events[], providerRecord }`. Each item carries `allocation_id` and `payment_id` so a payout can be traced to its source payment.

### `GET /api/payments` · `GET /api/payments/:id`
Payment facts, fee split, allocation split with weights, and applied refunds.

### `GET /api/events`
Structured audit log, newest first. Filters: `limit`, `payoutId`, `instructorId`, `event`.

### `GET /api/integrity`
Invariant checks. `ok: true` means: every balance snapshot equals Σ of its allocations; every payment's Σ allocations = distributable; no idempotency key has more than one provider transaction.

### `GET /api/plans` · `GET /api/students`
Reference data for the ops console.

## Ops endpoints (the "artisan commands" and queue jobs)

> These are an operator surface. Gate them behind access rules before production use.

### `POST /api/ops/payouts/run`
Equivalent of `php artisan revenue:payouts [--instructor=ID]`. Recognizes revenue, then prepares + processes one payout per instructor with a positive payable balance.

Body (optional): `{ "instructorId": 1, "limit": 500 }`

```json
{
  "asOf": "2026-11-01T15:25:07.319Z",
  "candidates": 1,
  "results": [
    { "instructorId": 1, "prepared": true, "payoutId": 5, "amountMinor": 3886,
      "before": "PENDING", "after": "VERIFY", "providerCalled": true,
      "note": "provider timeout; outcome uncertain -> VERIFY (reservation kept)" }
  ]
}
```

### `POST /api/ops/payouts/prepare/:instructorId`
`PrepareInstructorPayout` job only. Returns `{ created: true, payout }` or `{ created: false, reason }` where reason ∈ `NOTHING_PAYABLE | ACTIVE_PAYOUT_EXISTS | LOST_RACE | INSTRUCTOR_INACTIVE`.

### `POST /api/ops/payouts/:id/process`
`ProcessInstructorPayout` job. **Safe to replay**: terminal payouts return `providerCalled: false`; `VERIFY` payouts resolve via status lookup, never a second create.

### `POST /api/ops/reconcile?force=1`
`ReconcilePayout` sweep over `VERIFY` payouts due by `next_check_at` and `PROCESSING` payouts older than `processing_stale_seconds`. `force=1` ignores `next_check_at`.

### `POST /api/ops/recognize`
Post earned-to-date deltas for every allocation as of the current clock.

### `POST /api/ops/payments`
Simulate a settled-payment webhook.
```json
{ "userId": 5, "planId": 3, "participants": [ { "instructorId": 1 }, { "instructorId": 2, "weight": 2 } ],
  "providerPaymentId": "pi_abc", "paidAt": "2026-10-01T00:00:00Z", "grossMinor": 39900 }
```
Idempotent on `providerPaymentId`.

### `POST /api/ops/refunds`
Simulate a refund webhook. `{ "paymentId": 6, "refundMinor": 20000, "providerRef": "re_001" }`
Response includes `instructorPoolMinor`, `platformExcessMinor` and per-allocation `lines`. Idempotent on `providerRef`.

### `GET | POST /api/ops/provider`
Read or set the mock provider scenario: `SUCCESS | PERMANENT_FAILURE | TIMEOUT_AFTER_SUCCESS | TIMEOUT_NO_EFFECT | STATUS_UNKNOWN`.

### `POST /api/ops/clock`
Freeze or advance the ledger clock for deterministic demos. `{ "now": "2026-12-01T00:00:00Z" }`, `{ "advanceDays": 30 }`, or `{ "now": null }` to unfreeze.

### `POST /api/ops/seed` · `POST /api/ops/reset`
Load the demo dataset (4 instructors, 3 plans, 6 subscriptions) / wipe all tables.
