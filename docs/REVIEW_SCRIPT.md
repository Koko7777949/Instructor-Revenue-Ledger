# Five-Minute Review Script

This is spec §16, executed against the live sandbox. Every command below was run and the outputs are real.

## 0. Reset and seed
```bash
curl -s -X POST $BASE/api/ops/reset   # {"reset":true}
curl -s -X POST $BASE/api/ops/seed    # {"seeded":true}
```

## 1. Schema and idempotency constraints
Open `migrations/0001_initial_schema.sql`. Point out:
- `payouts.idempotency_key UNIQUE`, `payouts.provider_transaction_id UNIQUE`
- partial index `uq_payouts_one_active_per_instructor ON payouts(instructor_id) WHERE status IN ('PENDING','PROCESSING','VERIFY')`
- `CHECK (paid_minor + reserved_minor <= recognized_minor)` on allocations
- `tx_guard` — the compare-and-swap primitive for atomic D1 batches

## 2. Uneven split (largest remainder)
`tests/unit/allocator.test.ts` — 10 000 cents across 3 equal weights → `3334 / 3333 / 3333`, sum exactly 10 000, extra cent to the lowest id.

## 3. Recognition + mid-term refund
`tests/unit/recognition.test.ts` (before term / first day / middle / final day / leap year / after expiry) and `tests/feature/payouts.test.ts › refunds`.

## 4. Payout command → PROCESSING → SUCCEEDED
```bash
curl -s -X POST $BASE/api/ops/payouts/run
```
```
candidates 4
  instructor 1  payout 1  11653  PENDING -> SUCCEEDED  provider success; settled
  instructor 2  payout 2   7151  PENDING -> SUCCEEDED
  instructor 3  payout 3   8293  PENDING -> SUCCEEDED
  instructor 4  payout 4   4650  PENDING -> SUCCEEDED
```

## 5. Run the same command again → no second provider transaction
```bash
curl -s -X POST $BASE/api/ops/payouts/run     # candidates 0
curl -s -X POST $BASE/api/ops/payouts/1/process
# {"payoutId":1,"before":"SUCCEEDED","after":"SUCCEEDED","providerCalled":false,"note":"terminal state; no provider call"}
```

## 6. TIMEOUT_AFTER_SUCCESS → VERIFY, reservation kept
```bash
curl -s -X POST $BASE/api/ops/clock    -H 'content-type: application/json' -d '{"advanceDays":30}'
curl -s -X POST $BASE/api/ops/provider -H 'content-type: application/json' -d '{"scenario":"TIMEOUT_AFTER_SUCCESS"}'
curl -s -X POST $BASE/api/ops/payouts/run -H 'content-type: application/json' -d '{"instructorId":1}'
```
```
instructor 1  payout 5  3886  PENDING -> VERIFY  provider timeout; outcome uncertain -> VERIFY (reservation kept)
```

## 7. Reconcile → status lookup finds SUCCESS → same payout finalized
```bash
curl -s -X POST $BASE/api/ops/payouts/5/process
# {"payoutId":5,"before":"VERIFY","after":"SUCCEEDED","providerCalled":true,
#  "note":"VERIFY resolved via status lookup: status lookup found SUCCESS; finalized exactly once"}

curl -s "$BASE/api/events?payoutId=5"
#  payout.reconciled             VERIFY     -> SUCCEEDED
#  payout.verification_started   PROCESSING -> VERIFY
#  payout.provider_called        PENDING    -> PROCESSING
#  payout.claimed                           -> PENDING

curl -s $BASE/api/integrity     # ok: true, duplicateProviderTransactions: 0
```

## 8. Permanent failure releases, later payout uses a new id
```bash
curl -s -X POST $BASE/api/ops/provider -d '{"scenario":"PERMANENT_FAILURE"}' -H 'content-type: application/json'
curl -s -X POST $BASE/api/ops/payouts/run -d '{"instructorId":2}' -H 'content-type: application/json'
#  payout 6  PENDING -> FAILED  provider permanent failure; reservation released
#  balance: earned 9222  paid 7151  reserved 0  -> available 2071

curl -s -X POST $BASE/api/ops/provider -d '{"scenario":"SUCCESS"}' -H 'content-type: application/json'
curl -s -X POST $BASE/api/ops/payouts/run -d '{"instructorId":2}' -H 'content-type: application/json'
#  payout 7  PENDING -> SUCCEEDED  amount 2071
```

## 9. Mid-term refund takes only unearned value
```bash
curl -s -X POST $BASE/api/ops/refunds -H 'content-type: application/json' \
  -d '{"paymentId":6,"providerRef":"re_demo_001","refundMinor":20000}'
#  instructorPool 20000  platformExcess 0
#   alloc 12 instr 1  refund 5000  of unearned 7713
#   alloc 13 instr 2  refund 5000  of unearned 7713
#   alloc 14 instr 3  refund 5000  of unearned 7713
#   alloc 15 instr 4  refund 5000  of unearned 7712
```

## 10. Test suite
```bash
npm test
#  Test Files  6 passed (6)
#       Tests  73 passed (73)
```
