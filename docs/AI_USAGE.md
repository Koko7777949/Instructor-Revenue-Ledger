# AI Usage Disclosure

> Edit this before submitting so it reflects what *you* personally did. Do not claim manual design or testing you did not perform.

## How AI was used

An AI coding assistant (Claude, via the Genspark developer sandbox) was used as an engineering aid throughout this project:

- **Input**: the *Instructor Revenue Ledger – Engineering Documentation Pack v1.0* (PDF) was provided by the author as the specification.
- **Stack decision**: the spec targets Laravel 11 / Filament 3 / Pest / MySQL. The assistant flagged that the available runtime (Cloudflare Workers + D1) cannot run PHP or MySQL and offered three options; the author chose a faithful port to **Hono + TypeScript + Cloudflare D1** so the system could be run, tested and previewed immediately.
- **Implementation support**: the assistant generated the D1 schema, pure domain functions (money, allocator, recognition, refund, state machine), services (intake, recognition, refund, payout prepare/process/finalize/reconcile), the mock provider, JSON API, read-only dashboard, and the Vitest suite from the spec's rules.
- **Review support**: the assistant reasoned about race conditions and crash windows (§8.3, §9) and encoded them as tests; it also identified and fixed an `/api/events` filter that ignored its query parameters during verification.
- **Documentation support**: README, this file and `docs/ARCHITECTURE.md` were drafted by the assistant from the implemented code and the spec.

## Main workflows

1. Read spec → enumerate business rules → write schema + domain functions.
2. Write tests for each rule and each required behaviour in §10.2 *before* wiring the API.
3. Implement services as single atomic batches with compare-and-swap guards.
4. Run the five-minute review script (§16) against the live sandbox via `curl` and the dashboard; fix anything that disagreed with the spec.

## Decisions that were made deliberately (not defaults)

- Straight-line **daily** recognition over a **half-open UTC** term.
- **Weighted largest-remainder** allocation in integer minor units with id-ascending tie-break.
- **Participant snapshot** at payment time; later catalog changes never rewrite a split.
- **`VERIFY`** as an explicit payout state for "provider timed out, money may have moved".
- **Stable idempotency key per payout row**; reconciliation queries by that same key.
- **Compare-and-swap guards inside atomic D1 batches** as the stand-in for `SELECT … FOR UPDATE`, plus a **partial unique index** guaranteeing one active payout per instructor at the database level.
- **Unused-time-only refunds**; excess beyond the unearned pool is recorded platform-side rather than clawed back.
- **Balance snapshot** maintained transactionally and verified against allocations by `/api/integrity`, never treated as the sole source of truth.
- **Mock provider keeps its own ledger** so "timeout after success" is a real stored fact, not a flag.

## What was verified by running, not just by reading

- `npm test`: 73 tests pass (unit + database-backed feature tests).
- Live sandbox: payout cycle run twice → second run finds 0 candidates; `TIMEOUT_AFTER_SUCCESS` → `VERIFY` → retry/reconcile → `SUCCEEDED` with exactly one provider transaction; `PERMANENT_FAILURE` → `FAILED` with reservation released and a later payout under a **new** id; mid-term refund taken only from unearned allocations; `/api/integrity` reports all invariants hold after every step.
