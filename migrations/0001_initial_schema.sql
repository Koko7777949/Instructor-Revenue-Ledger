-- Instructor Revenue Ledger - initial schema (D1 / SQLite)
-- All money values are INTEGER minor units (cents). Timestamps are ISO-8601 UTC strings.
-- Migration order follows documentation §4.4.

-- 1. users (minimal: students + instructor identities)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','instructor','admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 1b. instructors: identity + payout destination
CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  provider_account_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 2. plans
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  term_months INTEGER NOT NULL CHECK (term_months > 0),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  active INTEGER NOT NULL DEFAULT 1
);

-- 3. subscriptions: a student's prepaid entitlement
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','refunded','expired','cancelled')),
  provider_payment_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_ends ON subscriptions(status, ends_at, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status);

-- 3b. subscription_payments: the payment fact and provider reference
CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE RESTRICT,
  provider_payment_id TEXT NOT NULL UNIQUE,
  request_idempotency_key TEXT NOT NULL UNIQUE,
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  platform_fee_minor INTEGER NOT NULL CHECK (platform_fee_minor >= 0),
  distributable_minor INTEGER NOT NULL CHECK (distributable_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'settled' CHECK (status IN ('settled','partially_refunded','refunded')),
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (gross_minor = platform_fee_minor + distributable_minor)
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON subscription_payments(status, id);

-- 4. subscription_participants: immutable snapshot of instructors on that subscription
CREATE TABLE IF NOT EXISTS subscription_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  UNIQUE (subscription_id, instructor_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_instructor ON subscription_participants(instructor_id, subscription_id);

-- 5. revenue_allocations: one instructor's share of one payment
CREATE TABLE IF NOT EXISTS revenue_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES subscription_payments(id) ON DELETE RESTRICT,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  allocated_minor INTEGER NOT NULL CHECK (allocated_minor >= 0),
  recognized_minor INTEGER NOT NULL DEFAULT 0 CHECK (recognized_minor >= 0),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  reserved_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  term_start_at TEXT NOT NULL,
  term_end_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (payment_id, instructor_id),
  -- Invariants: recognized <= allocated - refunded ; paid + reserved <= recognized
  CHECK (recognized_minor + refunded_minor <= allocated_minor),
  CHECK (paid_minor + reserved_minor <= recognized_minor)
);
CREATE INDEX IF NOT EXISTS idx_alloc_instructor_progress ON revenue_allocations(instructor_id, recognized_minor, paid_minor);
CREATE INDEX IF NOT EXISTS idx_alloc_term_end ON revenue_allocations(term_end_at);

-- 6. refunds
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES subscription_payments(id) ON DELETE RESTRICT,
  provider_ref TEXT NOT NULL UNIQUE,
  refund_minor INTEGER NOT NULL CHECK (refund_minor >= 0),
  instructor_pool_minor INTEGER NOT NULL DEFAULT 0 CHECK (instructor_pool_minor >= 0),
  platform_excess_minor INTEGER NOT NULL DEFAULT 0 CHECK (platform_excess_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('pending','processed','rejected')),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status, id);

-- 6b. refund_allocations
CREATE TABLE IF NOT EXISTS refund_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  allocation_id INTEGER NOT NULL REFERENCES revenue_allocations(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (refund_id, allocation_id)
);
CREATE INDEX IF NOT EXISTS idx_refund_alloc_allocation ON refund_allocations(allocation_id);

-- 7. instructor_balances: transactional snapshot (performance optimization)
CREATE TABLE IF NOT EXISTS instructor_balances (
  instructor_id INTEGER PRIMARY KEY REFERENCES instructors(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  earned_minor INTEGER NOT NULL DEFAULT 0 CHECK (earned_minor >= 0),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  reserved_minor INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- available = earned - paid - reserved must never be negative
  CHECK (paid_minor + reserved_minor <= earned_minor)
);

-- 8. payouts: one settlement intent for one instructor
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','VERIFY','SUCCEEDED','FAILED')),
  provider_transaction_id TEXT UNIQUE,
  provider_outcome TEXT,
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processing_started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payouts_instructor_status ON payouts(instructor_id, status, id);
CREATE INDEX IF NOT EXISTS idx_payouts_status_created ON payouts(status, created_at);
-- "One instructor, one active payout" enforced at the DB level (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_one_active_per_instructor
  ON payouts(instructor_id) WHERE status IN ('PENDING','PROCESSING','VERIFY');

-- 8b. payout_items: allocation slices reserved / settled by a payout
CREATE TABLE IF NOT EXISTS payout_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE RESTRICT,
  allocation_id INTEGER NOT NULL REFERENCES revenue_allocations(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','PAID','RELEASED')),
  UNIQUE (payout_id, allocation_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_items_payout ON payout_items(payout_id, id);
CREATE INDEX IF NOT EXISTS idx_payout_items_allocation ON payout_items(allocation_id);

-- 9. Mock provider's own ledger (simulates the remote system's storage keyed by idempotency key)
CREATE TABLE IF NOT EXISTS mock_provider_transactions (
  idempotency_key TEXT PRIMARY KEY,
  provider_transaction_id TEXT NOT NULL UNIQUE,
  provider_account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','PENDING')),
  scenario TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 10. Structured audit log (payout.claimed, payout.provider_called, ...)
CREATE TABLE IF NOT EXISTS ledger_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  payout_id INTEGER,
  instructor_id INTEGER,
  idempotency_key TEXT,
  provider_transaction_id TEXT,
  amount_minor INTEGER,
  old_status TEXT,
  new_status TEXT,
  attempt INTEGER,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_payout ON ledger_events(payout_id, id);
CREATE INDEX IF NOT EXISTS idx_events_created ON ledger_events(created_at);

-- 11. Settings (mock provider scenario, frozen clock for demos, scheduler last_run)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('provider_scenario', 'SUCCESS');
INSERT OR IGNORE INTO settings (key, value) VALUES ('processing_stale_seconds', '300');

-- 12. Transaction guard. D1 has no interactive transactions / SELECT ... FOR UPDATE, but batch() is atomic.
-- `INSERT INTO tx_guard SELECT 'GUARD_FAILED' WHERE NOT EXISTS (<precondition>)` violates the CHECK
-- constraint when the precondition is false, aborting and rolling back the entire batch.
-- This is the compare-and-swap primitive used for every money-moving state transition.
CREATE TABLE IF NOT EXISTS tx_guard (
  k TEXT PRIMARY KEY,
  CONSTRAINT guard_condition CHECK (k = 'LOCK')
);
