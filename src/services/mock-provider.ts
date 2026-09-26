/**
 * Mock payment provider (§8). It keeps its OWN ledger keyed by idempotency key, so it can
 * faithfully simulate the dangerous case: money moved on the provider side but the caller
 * received a timeout. The scenario is read from settings (or forced via constructor) so the
 * ops console and tests can steer outcomes.
 *
 * Scenarios:
 *  SUCCESS               -> stores SUCCEEDED, returns success
 *  PERMANENT_FAILURE     -> stores FAILED, returns failure
 *  TIMEOUT_AFTER_SUCCESS -> stores SUCCEEDED, throws/returns TIMEOUT (caller learns nothing)
 *  TIMEOUT_NO_EFFECT     -> stores nothing, returns TIMEOUT (status later returns NOT_FOUND)
 *  STATUS_UNKNOWN        -> stores PENDING, returns TIMEOUT; status returns UNKNOWN until scenario changes
 *
 * Idempotency: a repeated create with the same key returns the stored record; it never moves money twice.
 */
import type { Db } from '../db'
import type { PayoutProvider, ProviderScenario } from '../domain/provider'
import { isProviderScenario } from '../domain/provider'
import type { ProviderCreateOutcome, ProviderStatusOutcome } from '../domain/payout-state'

interface ProviderRow {
  idempotency_key: string
  provider_transaction_id: string
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING'
  scenario: string
  call_count: number
}

export class MockPayoutProvider implements PayoutProvider {
  public createCalls = 0
  public statusCalls = 0

  constructor(private db: Db, private forcedScenario?: ProviderScenario) {}

  setScenario(s: ProviderScenario) {
    this.forcedScenario = s
  }

  async currentScenario(): Promise<ProviderScenario> {
    if (this.forcedScenario) return this.forcedScenario
    const row = await this.db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'provider_scenario'`)
    return row && isProviderScenario(row.value) ? row.value : 'SUCCESS'
  }

  async createPayout(idempotencyKey: string, providerAccountId: string, amountMinor: number, currency: string): Promise<ProviderCreateOutcome> {
    this.createCalls++
    if (amountMinor <= 0) return { kind: 'PERMANENT_FAILURE', reason: 'amount must be positive' }

    const existing = await this.db.first<ProviderRow>(`SELECT * FROM mock_provider_transactions WHERE idempotency_key = ?`, [idempotencyKey])
    if (existing) {
      // Idempotent replay: never move money twice. Return the stored outcome.
      await this.db.run(`UPDATE mock_provider_transactions SET call_count = call_count + 1 WHERE idempotency_key = ?`, [idempotencyKey])
      if (existing.status === 'SUCCEEDED') return { kind: 'SUCCESS', providerTransactionId: existing.provider_transaction_id }
      if (existing.status === 'FAILED') return { kind: 'PERMANENT_FAILURE', reason: 'provider recorded failure for this key' }
      return { kind: 'TIMEOUT' }
    }

    const scenario = await this.currentScenario()
    const txId = `ptx_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const store = async (status: ProviderRow['status']) => {
      await this.db.run(
        `INSERT INTO mock_provider_transactions (idempotency_key, provider_transaction_id, provider_account_id, amount_minor, currency, status, scenario)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [idempotencyKey, txId, providerAccountId, amountMinor, currency, status, scenario]
      )
    }

    switch (scenario) {
      case 'SUCCESS':
        await store('SUCCEEDED')
        return { kind: 'SUCCESS', providerTransactionId: txId }
      case 'PERMANENT_FAILURE':
        await store('FAILED')
        return { kind: 'PERMANENT_FAILURE', reason: 'insufficient destination account verification (mock)' }
      case 'TIMEOUT_AFTER_SUCCESS':
        await store('SUCCEEDED') // money moved!
        return { kind: 'TIMEOUT' }
      case 'TIMEOUT_NO_EFFECT':
        return { kind: 'TIMEOUT' } // nothing stored
      case 'STATUS_UNKNOWN':
        await store('PENDING')
        return { kind: 'TIMEOUT' }
    }
  }

  async getPayoutStatus(idempotencyKey: string): Promise<ProviderStatusOutcome> {
    this.statusCalls++
    const row = await this.db.first<ProviderRow>(`SELECT * FROM mock_provider_transactions WHERE idempotency_key = ?`, [idempotencyKey])
    if (!row) return { kind: 'STATUS_NOT_FOUND' }
    if (row.status === 'SUCCEEDED') return { kind: 'STATUS_SUCCEEDED', providerTransactionId: row.provider_transaction_id }
    if (row.status === 'FAILED') return { kind: 'STATUS_FAILED', reason: 'provider recorded failure' }

    // PENDING: resolves according to the *current* scenario so the ops console can "let it settle".
    const scenario = await this.currentScenario()
    if (scenario === 'STATUS_UNKNOWN') return { kind: 'STATUS_UNKNOWN' }
    const final: ProviderRow['status'] = scenario === 'PERMANENT_FAILURE' ? 'FAILED' : 'SUCCEEDED'
    await this.db.run(`UPDATE mock_provider_transactions SET status = ? WHERE idempotency_key = ?`, [final, idempotencyKey])
    return final === 'SUCCEEDED'
      ? { kind: 'STATUS_SUCCEEDED', providerTransactionId: row.provider_transaction_id }
      : { kind: 'STATUS_FAILED', reason: 'provider recorded failure' }
  }

  /** Test helper: how many provider transactions exist for a key (must always be 0 or 1). */
  async transactionsForKey(idempotencyKey: string): Promise<number> {
    const row = await this.db.first<{ n: number }>(`SELECT COUNT(*) n FROM mock_provider_transactions WHERE idempotency_key = ?`, [idempotencyKey])
    return row?.n ?? 0
  }
}
